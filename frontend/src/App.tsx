import { Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Home } from "./routes/Home";
import { Select } from "./routes/Select";
import { Binding } from "./routes/Binding";
import { Perturbation } from "./routes/Perturbation";
import { Comparison } from "./routes/Comparison";

export function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/select" element={<Select />} />
        <Route path="/binding" element={<Binding />} />
        <Route path="/perturbation" element={<Perturbation />} />
        <Route path="/comparison" element={<Comparison />} />
      </Routes>
    </Layout>
  );
}

export default App;
