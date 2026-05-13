import type { Schemas } from "@/api/client";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";

interface DTOPlotProps {
  rows: Schemas["DTORow"][];
}

// Renders the DTO precomputed comparison table. Parity target is the small
// table in the reference Python Shiny app.
export function DTOPlot({ rows }: DTOPlotProps) {
  if (rows.length === 0) {
    return <p className="text-sm text-slate-600">No DTO rows available.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <THead>
          <TR>
            <TH>Binding ID</TH>
            <TH>Pert ID</TH>
            <TH>DTO empirical pvalue</TH>
            <TH>DTO FDR</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((r, i) => (
            <TR key={`${r.bindingIdSource}-${r.perturbationIdSource}-${r.time}-${i}`}>
              <TD>{r.bindingIdSource}</TD>
              <TD>{r.perturbationIdSource}</TD>
              <TD>{r.dtoEmpiricalPvalue.toExponential(2)}</TD>
              <TD>{r.dtoFdr.toExponential(2)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
