import { Link } from "react-router-dom";

export function Home() {
  return (
    <article className="prose prose-slate max-w-none">
      <div
        role="alert"
        className="not-prose mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
      >
        <strong>Under development:</strong> excuse the mess. Projected release: April, 2026.
      </div>

      <h1>Welcome to the TF Binding and Perturbation Explorer</h1>
      <p>
        Explore datasets of transcription factor (TF) binding and gene expression responses
        following TF perturbation. Compare growth conditions, experimental techniques, or
        analytic techniques. Currently, all datasets are for <em>Saccharomyces cerevisiae</em>{" "}
        (yeast).
      </p>

      <h2>Getting Started</h2>
      <p>The links below take you to pages for selecting and comparing datasets.</p>

      <ul>
        <li>
          <Link to="/select">
            <strong>Dataset selection</strong>
          </Link>
          {" — "}Begin here to choose and filter the datasets you want to analyse, then navigate
          to the other pages to explore the results.
        </li>
        <li>
          <Link to="/binding">
            <strong>Binding</strong>
          </Link>
          {" — "}Compare TF binding targets in the selected binding datasets.
        </li>
        <li>
          <Link to="/perturbation">
            <strong>Perturbation</strong>
          </Link>
          {" — "}Compare transcriptional responses to TF perturbations in the selected
          perturbation datasets.
        </li>
        <li>
          <Link to="/comparison">
            <strong>Comparison</strong>
          </Link>
          {" — "}Compare selected binding datasets to selected perturbation datasets.
        </li>
      </ul>
    </article>
  );
}
