package cache

import (
	"net/url"
	"sort"
	"strings"
)

func Key(artifactVersion, method, path string, q url.Values) string {
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var sb strings.Builder
	for i, k := range keys {
		if i > 0 {
			sb.WriteByte('&')
		}
		vs := append([]string(nil), q[k]...)
		sort.Strings(vs)
		sb.WriteString(url.QueryEscape(k))
		sb.WriteByte('=')
		sb.WriteString(url.QueryEscape(strings.Join(vs, ",")))
	}
	return artifactVersion + "|" + method + "|" + path + "|" + sb.String()
}
