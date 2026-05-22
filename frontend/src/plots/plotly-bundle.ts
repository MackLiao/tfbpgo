import Plotly from "plotly.js/lib/core";
import scatter from "plotly.js/lib/scatter";
import scattergl from "plotly.js/lib/scattergl";
import heatmap from "plotly.js/lib/heatmap";
import bar from "plotly.js/lib/bar";
import box from "plotly.js/lib/box";
// histogram2d dropped to keep gzip under the 512 KB target (see Task 8 plan).
// import histogram2d from "plotly.js/lib/histogram2d";

Plotly.register([scatter, scattergl, heatmap, bar, box]);
export default Plotly;
