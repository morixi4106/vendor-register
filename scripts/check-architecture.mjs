import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs"];

export const DEFAULT_LINE_BUDGETS = Object.freeze({
  "app/routes/admin.products.$id.jsx": 700,
  "app/routes/app.production-readiness.jsx": 600,
  "app/routes/app.vendor-dashboard.jsx": 450,
  "app/routes/app.withdrawals.jsx": 350,
  "app/routes/app.withdrawals_.$id.jsx": 600,
  "app/routes/preview.vendors.$handle.jsx": 100,
  "app/components/products/AdminProductDetailPage.jsx": 1100,
  "app/components/readiness/ProductionReadinessPage.jsx": 950,
  "app/components/readiness/productionReadinessViewModel.js": 350,
  "app/components/vendors/AdminVendorDashboardPage.jsx": 750,
  "app/components/vendors/VendorPreviewPage.jsx": 1050,
  "app/components/withdrawals/WithdrawalDetailPage.jsx": 1600,
  "app/components/withdrawals/WithdrawalListPage.jsx": 800,
  "app/components/withdrawals/withdrawalDetailViewModel.js": 1150,
  "app/services/adminProductDetail.server.js": 400,
  "app/services/productionReadiness.server.js": 150,
  "app/services/productionReadiness/orchestrator.server.js": 350,
  "app/services/productionReadiness/withdrawals.server.js": 500,
  "app/services/operationalReadiness.server.js": 1900,
  "app/services/sellerPayments.server.js": 150,
  "app/services/sellerPayments/sellerAccounts.server.js": 1150,
  "app/services/sellerPayments/shared.server.js": 900,
  "app/services/sellerPayments/stripeWebhook.server.js": 850,
  "app/services/sellerPayments/settlements/common.server.js": 1450,
  "app/services/sellerPayments/settlements/paid.server.js": 1800,
  "app/services/sellerPayments/payouts/wise.server.js": 800,
  "app/services/vendorManagement.server.js": 150,
  "app/services/vendorManagement/orders.server.js": 1200,
  "app/services/vendorManagement/fulfillment.server.js": 850,
  "app/services/withdrawalAdminList.server.js": 900,
  "app/services/withdrawalDirectReturns.server.js": 150,
  "app/services/withdrawalDirectReturns/initialize.server.js": 675,
  "app/services/withdrawals.server.js": 150,
  "app/services/withdrawals/common.js": 1600,
  "app/services/withdrawals/submission.server.js": 600,
});

export const COMPATIBILITY_FACADES = Object.freeze([
  {
    directory: "app/services/productionReadiness/",
    facade: "app/services/productionReadiness.server.js",
  },
  {
    directory: "app/services/sellerPayments/",
    facade: "app/services/sellerPayments.server.js",
  },
  {
    directory: "app/services/vendorManagement/",
    facade: "app/services/vendorManagement.server.js",
  },
  {
    directory: "app/services/withdrawalDirectReturns/",
    facade: "app/services/withdrawalDirectReturns.server.js",
  },
  {
    directory: "app/services/withdrawals/",
    facade: "app/services/withdrawals.server.js",
  },
]);

export const FORBIDDEN_IMPORTS = Object.freeze([
  {
    importer: "app/services/marketplaceCheckoutGate.server.js",
    imported: "app/services/operationalReadiness.server.js",
  },
  {
    importer: "app/services/saleEligibility.server.js",
    imported: "app/services/operationalReadiness.server.js",
  },
  {
    importer: "app/services/withdrawalEmailOutbox.server.js",
    imported: "app/services/operationalReadiness.server.js",
  },
]);

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function listSourceFiles(directory) {
  if (!fs.existsSync(directory)) return [];

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(absolutePath);
    return SOURCE_EXTENSIONS.includes(path.extname(entry.name))
      ? [absolutePath]
      : [];
  });
}

export function parseStaticImportSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /(?:import|export)\s+[\s\S]*?\s+from\s+["']([^"']+)["']/g,
    /import\s+["']([^"']+)["']/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]?.startsWith(".")) specifiers.push(match[1]);
    }
  }

  return Array.from(new Set(specifiers));
}

function resolveSourceImport(importer, specifier, sourceFiles) {
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) =>
      path.join(base, `index${extension}`),
    ),
  ];

  return (
    candidates.find((candidate) =>
      sourceFiles.has(path.normalize(candidate)),
    ) || null
  );
}

export function buildStaticImportGraph({
  rootDir,
  directory = "app/services",
}) {
  const absoluteDirectory = path.resolve(rootDir, directory);
  const files = listSourceFiles(absoluteDirectory).map(path.normalize);
  const sourceFiles = new Set(files);
  const graph = new Map();

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const dependencies = parseStaticImportSpecifiers(source)
      .map((specifier) => resolveSourceImport(file, specifier, sourceFiles))
      .filter(Boolean);
    graph.set(file, Array.from(new Set(dependencies)));
  }

  return graph;
}

export function findImportCycles(graph) {
  let nextIndex = 0;
  const indexes = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const cycles = [];

  function visit(node) {
    indexes.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const dependency of graph.get(node) || []) {
      if (!indexes.has(dependency)) {
        visit(dependency);
        lowLinks.set(
          node,
          Math.min(lowLinks.get(node), lowLinks.get(dependency)),
        );
      } else if (onStack.has(dependency)) {
        lowLinks.set(
          node,
          Math.min(lowLinks.get(node), indexes.get(dependency)),
        );
      }
    }

    if (lowLinks.get(node) !== indexes.get(node)) return;

    const component = [];
    let current;
    do {
      current = stack.pop();
      onStack.delete(current);
      component.push(current);
    } while (current !== node);

    if (component.length > 1) cycles.push(component);
  }

  for (const node of graph.keys()) {
    if (!indexes.has(node)) visit(node);
  }

  return cycles;
}

export function inspectArchitecture({
  rootDir = process.cwd(),
  lineBudgets = DEFAULT_LINE_BUDGETS,
  forbiddenImports = FORBIDDEN_IMPORTS,
  compatibilityFacades = COMPATIBILITY_FACADES,
} = {}) {
  const errors = [];
  const graph = buildStaticImportGraph({ rootDir });

  for (const cycle of findImportCycles(graph)) {
    errors.push({
      code: "service_import_cycle",
      detail: cycle
        .map((file) => normalizePath(path.relative(rootDir, file)))
        .sort()
        .join(" -> "),
    });
  }

  for (const [relativePath, limit] of Object.entries(lineBudgets)) {
    const absolutePath = path.resolve(rootDir, relativePath);
    if (!fs.existsSync(absolutePath)) {
      errors.push({ code: "architecture_file_missing", detail: relativePath });
      continue;
    }

    const lineCount = fs
      .readFileSync(absolutePath, "utf8")
      .split(/\r?\n/).length;
    if (lineCount > limit) {
      errors.push({
        code: "architecture_line_budget_exceeded",
        detail: `${relativePath}: ${lineCount} > ${limit}`,
      });
    }
  }

  for (const rule of forbiddenImports) {
    const importer = path.normalize(path.resolve(rootDir, rule.importer));
    const imported = path.normalize(path.resolve(rootDir, rule.imported));
    if ((graph.get(importer) || []).includes(imported)) {
      errors.push({
        code: "forbidden_architecture_import",
        detail: `${rule.importer} -> ${rule.imported}`,
      });
    }
  }

  for (const boundary of compatibilityFacades) {
    const facade = path.normalize(path.resolve(rootDir, boundary.facade));
    for (const [importer, dependencies] of graph.entries()) {
      const relativeImporter = normalizePath(path.relative(rootDir, importer));
      if (
        relativeImporter.startsWith(boundary.directory) &&
        dependencies.includes(facade)
      ) {
        errors.push({
          code: "compatibility_facade_reverse_dependency",
          detail: `${relativeImporter} -> ${boundary.facade}`,
        });
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    serviceCount: graph.size,
  };
}

function isDirectExecution() {
  return (
    process.argv[1] &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  );
}

if (isDirectExecution()) {
  const result = inspectArchitecture();
  if (!result.ok) {
    for (const error of result.errors) {
      console.error(`[${error.code}] ${error.detail}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`Architecture check passed (${result.serviceCount} services).`);
  }
}
