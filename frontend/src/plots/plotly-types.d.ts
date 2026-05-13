declare module "plotly.js/lib/core" {
  const Plotly: any;
  export default Plotly;
}
declare module "plotly.js/lib/scatter" {
  const trace: any;
  export default trace;
}
declare module "plotly.js/lib/scattergl" {
  const trace: any;
  export default trace;
}
declare module "plotly.js/lib/heatmap" {
  const trace: any;
  export default trace;
}
declare module "plotly.js/lib/bar" {
  const trace: any;
  export default trace;
}
// histogram2d dropped to keep gzip under the 512 KB target (see Task 8 plan).
// declare module "plotly.js/lib/histogram2d" {
//   const trace: any;
//   export default trace;
// }
