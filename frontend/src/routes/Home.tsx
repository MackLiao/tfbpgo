import { Link, useLocation } from "react-router-dom";
import { Card } from "@/components/ui/card";

interface FeatureCardProps {
  title: string;
  to: string;
  description: string;
  image?: { src: string; alt: string };
  // AC-4: current query string, carried forward so a selection made elsewhere
  // (and reflected in the URL via the nav) survives a feature-card click.
  search?: string;
}

function FeatureCard({
  title,
  to,
  description,
  image,
  search,
}: FeatureCardProps) {
  return (
    <Card className="mb-3">
      <div className="flex items-center gap-4">
        {image ? (
          <img
            src={image.src}
            alt={image.alt}
            className="flex-shrink-0"
            style={{ width: "100px", height: "100px", objectFit: "contain" }}
          />
        ) : null}
        <div>
          <div className="mb-1 text-lg font-bold">
            <Link
              to={{ pathname: to, search: search ?? "" }}
              className="text-wine hover:text-wine-hover"
            >
              {title}
            </Link>
          </div>
          <div className="text-sm text-slate-700">{description}</div>
        </div>
      </div>
    </Card>
  );
}

export function Home() {
  const { search } = useLocation();
  return (
    <article className="prose prose-slate max-w-none">
      <div
        role="alert"
        className="not-prose mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
      >
        <strong>Under development:</strong> excuse the mess. Projected release:
        April, 2026.
      </div>

      <h1>Welcome to the TF Binding and Perturbation Explorer</h1>
      <p>
        Explore datasets of transcription factor (TF) binding and gene
        expression responses following TF perturbation. Compare growth
        conditions, experimental techniques, or analytic techniques. Currently,
        all datasets are for <em>Saccharomyces cerevisiae</em> (yeast).
      </p>

      <h2>Getting Started</h2>
      <p>
        The tabs above take you to pages for selecting and comparing datasets.
      </p>

      <div className="not-prose mt-3">
        <FeatureCard
          title="Dataset selection"
          to="/select"
          search={search}
          description="Begin here to choose and filter the datasets you want to analyse, then navigate to the other tabs to explore the results."
        />
        <FeatureCard
          title="Binding"
          to="/binding"
          search={search}
          description="Compare TF binding targets in the selected binding datasets."
          image={{ src: "/binding.png", alt: "Binding diagram" }}
        />
        <FeatureCard
          title="Perturbation"
          to="/perturbation"
          search={search}
          description="Compare transcriptional responses to TF perturbations in the selected perturbation datasets."
          image={{ src: "/perturbation.png", alt: "Perturbation diagram" }}
        />
        <FeatureCard
          title="Comparison"
          to="/comparison"
          search={search}
          description="Compare selected binding datasets to selected perturbation datasets."
        />
      </div>
    </article>
  );
}
