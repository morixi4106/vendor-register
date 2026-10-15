import fs from "node:fs";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { productionReadinessStyles } from "../../app/components/readiness/ProductionReadinessPage.styles.js";
import { buildProductionReadinessPageState } from "../../app/components/readiness/productionReadinessPageState.js";
import { operationalEvidenceAnchor } from "../../app/components/readiness/launchPreparationViewModel.js";
import { CHECKOUT_VALIDATION_LIVE_PROBE_SCENARIOS } from "../../app/services/checkoutValidationLiveProbe.js";
import * as viewModel from "../../app/components/readiness/productionReadinessViewModel.js";

function compileComponent(name, dependencies) {
  const source = ts.createSourceFile(
    name,
    fs.readFileSync(
      new URL(`../../app/components/readiness/${name}`, import.meta.url),
      "utf8",
    ),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JSX,
  );
  const file = ts.factory.updateSourceFile(
    source,
    source.statements.filter((node) => !ts.isImportDeclaration(node)),
  );
  const code = ts.transpileModule(ts.createPrinter().printFile(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  const exported = {};
  new Function("exports", "React", ...Object.keys(dependencies), code)(
    exported,
    React,
    ...Object.values(dependencies),
  );
  return exported;
}

export function renderProductionReadinessPage(data) {
  const router = {
    Form: ({ children, method, ...props }) =>
      React.createElement("form", { method, ...props }, children),
    Link: ({ children, to, ...props }) =>
      React.createElement("a", { href: to, ...props }, children),
    useLoaderData: () => data,
    useActionData: () => null,
    useNavigation: () => ({ state: "idle" }),
  };
  const primitives = compileComponent(
    "ProductionReadinessPrimitives.jsx",
    viewModel,
  );
  const baseline = compileComponent(
    "KomojuLimitedLaunchBaselineControl.jsx",
    router,
  );
  const page = compileComponent("ProductionReadinessPage.jsx", {
    ...router,
    ...viewModel,
    ...primitives,
    ...baseline,
    productionReadinessStyles,
    buildProductionReadinessPageState,
    operationalEvidenceAnchor,
    CHECKOUT_VALIDATION_LIVE_PROBE_SCENARIOS,
  });
  return renderToStaticMarkup(React.createElement(page.default));
}
