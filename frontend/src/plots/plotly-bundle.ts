import Plotly from "plotly.js/lib/core";
import scatter from "plotly.js/lib/scatter";
import scattergl from "plotly.js/lib/scattergl";
import heatmap from "plotly.js/lib/heatmap";
import box from "plotly.js/lib/box";
// histogram2d dropped to keep gzip under the 512 KB target (see Task 8 plan).
// import histogram2d from "plotly.js/lib/histogram2d";
// `bar` dropped post-B1: ComparisonHeatmap was the only `bar` consumer
// and B1 replaced it with a faceted boxplot. Removed in Task C8 to
// recover gzip headroom below the 512 KB soft target.

Plotly.register([scatter, scattergl, heatmap, box]);
export default Plotly;
