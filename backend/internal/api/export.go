package api

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
)

// ExportTimeout caps a single export request. Holds a pool connection
// for the entire duration; on a 2-connection pool this is acceptable
// only because exports are user-initiated downloads (not driven by
// automated polling).
const ExportTimeout = 5 * time.Minute

// ExportRowCap is the per-dataset row cap for the streamed CSV. When the
// underlying SELECT yields more rows than this, the CSV stops at the cap
// and a trailing `# truncated at <N> rows; refine your filter and retry`
// marker row is emitted. Defends against OOM on an unfiltered all-dataset
// export against the production artifact (some datasets carry several
// million rows). Operator can re-export with tighter filters.
const ExportRowCap = 1_000_000

// exportSemaphore serializes /export requests so the handler can never
// occupy both of the t3.small pool's MaxOpenConns=2 slots simultaneously.
// Cap of 1 means at most one in-flight export; a second concurrent caller
// blocks until the first finishes (or its own request context is cancelled).
// Operators can raise this if production data shows the queue is the
// bottleneck — but the conservative default keeps one connection free for
// the rest of the API even during a 5-minute export.
var exportSemaphore = make(chan struct{}, 1)

// Export streams a multi-dataset .tar.gz archive. One subdirectory per
// requested dataset (named by db_name); each contains:
//
//   - metadata.csv          — SELECT * FROM {db}_meta {filters}
//   - annotated_features.csv — SELECT * FROM {db}      {filters}
//   - README.md             — display name, db_name, applied filters
//
// Mirrors reference/tfbpshiny/modules/select_datasets/export.py:39-213.
// Gzip compresslevel=1 to match Shiny's setting. STREAMS: rows are
// written to the CSV writer one at a time and the writer flushes every
// 1024 rows. Tar requires up-front Size for each entry, so each CSV is
// buffered in memory once-per-dataset (one dataset at a time — never
// the whole archive).
//
// Caching: deliberately NOT cached (large responses, low repeat-rate).
// Response carries Cache-Control: no-store.
//
// Connection budget: holds one of the two pool connections for the full
// export duration. Accepted because (a) user-initiated only, (b) capped
// at 5 minutes via context, (c) the other connection remains available
// to keep the rest of the API responsive, (d) at most one /export
// is in-flight at a time (see exportSemaphore).
//
// Row budget: each per-dataset CSV is capped at ExportRowCap rows. On
// overflow a final `# truncated at <N> rows; refine your filter and
// retry` marker row is emitted and the next file in the tar continues.
// Defends against OOM on unfiltered all-dataset exports.
func (s *Server) Export(w http.ResponseWriter, r *http.Request) {
	// Serialize against any other in-flight /export. With MaxOpenConns=2,
	// allowing a second concurrent export would let two long-running
	// streams squat on both pool slots and starve every other handler.
	// The acquire is gated on the request context so a client disconnect
	// or router-level deadline (30s middleware.Timeout) unblocks the queue.
	select {
	case exportSemaphore <- struct{}{}:
		defer func() { <-exportSemaphore }()
	case <-r.Context().Done():
		writeJSONError(w, http.StatusRequestTimeout, "export queue timeout")
		return
	}

	q := r.URL.Query()

	dsRaw := q.Get("datasets")
	if dsRaw == "" {
		writeJSONError(w, http.StatusBadRequest, "datasets required")
		return
	}
	dsList, err := dedupeAndCapCSV("datasets", splitCSV(dsRaw), len(s.Whitelist.AllDatasets()))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(dsList) == 0 {
		writeJSONError(w, http.StatusBadRequest, "datasets required")
		return
	}
	for _, name := range dsList {
		if err := s.Whitelist.CheckDataset(name); err != nil {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	rawFilters := q.Get("filters")
	if err := validateLength("filters", rawFilters, MaxFiltersBytes); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	filters, err := parseFilters(rawFilters)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	for dbName, fs := range filters {
		for fld := range fs {
			if err := s.Whitelist.CheckField(dbName, fld); err != nil {
				writeJSONError(w, http.StatusBadRequest, err.Error())
				return
			}
		}
	}

	// Detach from the router-level 30s middleware.Timeout. We need up
	// to 5 minutes for a multi-dataset export. context.WithoutCancel
	// keeps the request's Value lookups (logger, observability) but
	// drops the parent's cancellation; we then apply our own 5-minute
	// deadline. Trade-off: we no longer observe client-disconnect via
	// ctx — but the next w.Write surfaces that as an error anyway.
	baseCtx := context.WithoutCancel(r.Context())
	ctx, cancel := context.WithTimeout(baseCtx, ExportTimeout)
	defer cancel()

	// Headers MUST be set before any body bytes are written. After the
	// first Write we can no longer change status; mid-stream failures
	// surface as a truncated download with an error in the server log.
	ts := time.Now().UTC().Format("20060102-150405")
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="tfbp-export-%s.tar.gz"`, ts))
	w.Header().Set("Cache-Control", "no-store")
	// Tar streams an unknown total length; do not set Content-Length.

	gz, err := gzip.NewWriterLevel(w, gzip.BestSpeed) // == compresslevel=1
	if err != nil {
		// Should be impossible — BestSpeed is a constant level. Log and
		// surface as 500 since we haven't written any body yet.
		slog.Error("export_gzip_init_failed", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	tw := tar.NewWriter(gz)

	wrote := false
	for _, dbName := range dsList {
		row, _ := s.Whitelist.Dataset(dbName)

		// metadata.csv — {db}_meta {filters}
		if err := s.writeQueryToTar(ctx, tw,
			dbName+"/metadata.csv", dbName+"_meta", dbName, filters[dbName]); err != nil {
			slog.Error("export_dataset_failed",
				"phase", "metadata", "dataset", dbName, "err", err)
			break
		}
		// annotated_features.csv — {db} {filters}
		if err := s.writeQueryToTar(ctx, tw,
			dbName+"/annotated_features.csv", dbName, dbName, filters[dbName]); err != nil {
			slog.Error("export_dataset_failed",
				"phase", "data", "dataset", dbName, "err", err)
			break
		}
		// README.md
		readme := buildExportReadme(dbName, row, filters[dbName])
		if err := writeBytesToTar(tw, dbName+"/README.md", []byte(readme)); err != nil {
			slog.Error("export_dataset_failed",
				"phase", "readme", "dataset", dbName, "err", err)
			break
		}
		wrote = true
	}

	if err := tw.Close(); err != nil {
		slog.Error("export_tar_close_failed", "err", err)
	}
	if err := gz.Close(); err != nil {
		slog.Error("export_gzip_close_failed", "err", err)
	}
	if !wrote {
		slog.Warn("export_empty_archive", "datasets", dsList)
	}
}

// writeQueryToTar runs `SELECT * FROM {table} WHERE 1=1 {extra_where}`
// and adds the CSV result as a single tar entry. Streams rows from the
// DuckDB cursor into a CSV writer, flushing every 1024 rows. The CSV
// bytes accumulate in a bytes.Buffer because tar's stdlib API requires
// the entry Size up front; a chunked-streaming alternative (PAX records
// + manual offset bookkeeping) is unnecessary for the t3.small workload.
// The peak memory is one dataset's CSV at a time (never the whole
// archive).
//
// dbName is the manifest db_name (already Whitelist-checked); table is
// `{dbName}` or `{dbName}_meta`. Both are re-checked against
// SafeIdentRE as defense-in-depth before SQL interpolation.
func (s *Server) writeQueryToTar(ctx context.Context, tw *tar.Writer, tarPath, table, dbName string, fs map[string]domain.FilterSpec) error {
	// dbName is whitelist-checked at the request boundary; re-verify here as
	// the per-request tripwire even though only `table` lands in the SQL
	// string. Matches the pattern used in binding.go / correlation.go where
	// every identifier passed to fmt.Sprintf flows through whitelistedIdent.
	_ = whitelistedIdent(dbName)

	extraWhere, args, err := buildSquirrelWhere(fs)
	if err != nil {
		return fmt.Errorf("build where: %w", err)
	}
	sqlStr := fmt.Sprintf(`SELECT * FROM %s WHERE 1=1%s`, quotedIdent(table), extraWhere)

	dbCtx, cancel := context.WithTimeout(ctx, db.QueryTimeout)
	defer cancel()
	t0 := time.Now()
	rows, err := s.Pool.DB.QueryxContext(dbCtx, sqlStr, args...)
	if err != nil {
		return fmt.Errorf("query: %w", err)
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		return fmt.Errorf("columns: %w", err)
	}

	var csvBuf bytes.Buffer
	csvw := csv.NewWriter(&csvBuf)
	if err := csvw.Write(cols); err != nil {
		return fmt.Errorf("csv header: %w", err)
	}

	rowVals := make([]any, len(cols))
	rowPtrs := make([]any, len(cols))
	for i := range rowVals {
		rowPtrs[i] = &rowVals[i]
	}
	strRow := make([]string, len(cols))

	rowCount := 0
	truncated := false
	for rows.Next() {
		if rowCount >= ExportRowCap {
			// Stop streaming further rows but keep the request alive:
			// the README/metadata.csv siblings for this dataset still
			// need to land, and subsequent datasets in the archive
			// should still be exported. The trailing marker row signals
			// the truncation to the consumer.
			truncated = true
			break
		}
		if err := rows.Scan(rowPtrs...); err != nil {
			return fmt.Errorf("scan: %w", err)
		}
		for i, v := range rowVals {
			strRow[i] = formatCSVCell(v)
		}
		if err := csvw.Write(strRow); err != nil {
			return fmt.Errorf("csv row: %w", err)
		}
		rowCount++
		if rowCount%1024 == 0 {
			csvw.Flush()
			if err := csvw.Error(); err != nil {
				return fmt.Errorf("csv flush: %w", err)
			}
		}
	}
	if truncated {
		// Emit a single-column marker as the final CSV row. Encoded via
		// csv.Writer so the leading `#` is properly quoted if the column
		// count differs from the header. Consumers parsing the CSV will
		// see the marker in the first cell of the last row.
		marker := make([]string, len(cols))
		marker[0] = fmt.Sprintf("# truncated at %d rows; refine your filter and retry", ExportRowCap)
		if err := csvw.Write(marker); err != nil {
			return fmt.Errorf("csv truncation marker: %w", err)
		}
		slog.Warn("export_truncated",
			"table", table,
			"dataset", dbName,
			"cap", ExportRowCap,
		)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("rows: %w", err)
	}
	csvw.Flush()
	if err := csvw.Error(); err != nil {
		return fmt.Errorf("csv final flush: %w", err)
	}
	elapsed := time.Since(t0)
	slog.Debug("export_query_complete",
		"table", table,
		"rows", rowCount,
		"bytes", csvBuf.Len(),
		"elapsed_ms", elapsed.Milliseconds(),
	)
	if s.Metrics != nil {
		s.Metrics.DBDuration.WithLabelValues("export/" + table).Observe(elapsed.Seconds())
	}

	hdr := &tar.Header{
		Name:    tarPath,
		Mode:    0o644,
		Size:    int64(csvBuf.Len()),
		ModTime: time.Now().UTC(),
	}
	if err := tw.WriteHeader(hdr); err != nil {
		return fmt.Errorf("tar header: %w", err)
	}
	if _, err := io.Copy(tw, &csvBuf); err != nil {
		return fmt.Errorf("tar copy: %w", err)
	}
	return nil
}

// writeBytesToTar writes an in-memory byte slice as a tar entry.
func writeBytesToTar(tw *tar.Writer, name string, body []byte) error {
	hdr := &tar.Header{
		Name:    name,
		Mode:    0o644,
		Size:    int64(len(body)),
		ModTime: time.Now().UTC(),
	}
	if err := tw.WriteHeader(hdr); err != nil {
		return fmt.Errorf("tar header: %w", err)
	}
	if _, err := tw.Write(body); err != nil {
		return fmt.Errorf("tar write: %w", err)
	}
	return nil
}

// buildExportReadme produces a short markdown summary for the per-
// dataset subdirectory. Mirrors `build_readme` in
// reference/tfbpshiny/modules/select_datasets/export.py:58-81 with an
// additional "Applied filters" section so archives remain traceable.
func buildExportReadme(dbName string, row db.DatasetRow, fs map[string]domain.FilterSpec) string {
	var b bytes.Buffer
	display := row.DisplayName
	if display == "" {
		display = dbName
	}
	fmt.Fprintf(&b, "# %s\n\n", display)
	fmt.Fprintf(&b, "- db_name: `%s`\n", dbName)
	if row.DataType != "" {
		fmt.Fprintf(&b, "- data_type: `%s`\n", row.DataType)
	}
	if row.Assay != "" {
		fmt.Fprintf(&b, "- assay: `%s`\n", row.Assay)
	}
	if row.SourceRepo != "" {
		fmt.Fprintf(&b, "- source_repo: `%s`\n", row.SourceRepo)
	}
	fmt.Fprintf(&b, "- exported_at: `%s`\n\n", time.Now().UTC().Format(time.RFC3339))
	b.WriteString("## Contents\n\n")
	b.WriteString("- **metadata.csv** — Sample-level metadata (one row per sample).\n")
	b.WriteString("- **annotated_features.csv** — Full per-feature data for this dataset.\n\n")
	b.WriteString("## Applied filters\n\n")
	if len(fs) == 0 {
		b.WriteString("_No filters applied._\n")
	} else {
		pretty, err := json.MarshalIndent(fs, "", "  ")
		if err != nil {
			fmt.Fprintf(&b, "_filter serialization error: %v_\n", err)
		} else {
			b.WriteString("```json\n")
			b.Write(pretty)
			b.WriteString("\n```\n")
		}
	}
	fmt.Fprintf(&b, "\n## Limits\n\n")
	fmt.Fprintf(&b, "Each CSV is capped at %d rows. If the cap is hit, the final row carries a `# truncated …` marker — refine your filter and re-export.\n", ExportRowCap)
	return b.String()
}

// formatCSVCell renders a DuckDB-returned value as a CSV cell. NULLs
// become the empty string (matching Python csv default); bool emits
// the SQL-canonical lowercase form; time.Time uses RFC3339; everything
// else falls through to %v.
func formatCSVCell(v any) string {
	if v == nil {
		return ""
	}
	switch x := v.(type) {
	case string:
		return x
	case []byte:
		return string(x)
	case time.Time:
		return x.UTC().Format(time.RFC3339)
	case bool:
		if x {
			return "true"
		}
		return "false"
	default:
		return fmt.Sprintf("%v", v)
	}
}
