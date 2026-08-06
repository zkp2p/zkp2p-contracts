#!/usr/bin/env ts-node
import 'ts-node/register/transpile-only';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const DEFAULT_PKG_ROOT = path.resolve(__dirname, '..');

// Modules to build
const MODULES = ['addresses', 'abis', 'constants', 'paymentMethods', 'currencies', 'oracleFeeds', 'networks', 'utils'];

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function createJsonModule(content: string, format: 'esm' | 'cjs'): string {
  const parsed = JSON.parse(content);
  const serialized = JSON.stringify(parsed, null, 2);

  if (format === 'esm') {
    return `const data = ${serialized};\nexport default data;\n`;
  }

  return `const data = ${serialized};\nmodule.exports = data;\nmodule.exports.default = data;\n`;
}

export function resolveEsmSpecifier(specifier: string, importerPath: string): string {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return specifier;
  if (specifier.endsWith('.js') || specifier.endsWith('.mjs')) return specifier;

  const sourcePath = path.resolve(path.dirname(importerPath), specifier);
  const candidates = [
    { source: sourcePath.endsWith('.json') ? sourcePath : `${sourcePath}.json`, suffix: '.js' },
    { source: sourcePath.endsWith('.ts') ? sourcePath : `${sourcePath}.ts`, suffix: '.js' },
    { source: path.join(sourcePath, 'index.ts'), suffix: '/index.js' },
    { source: path.join(sourcePath, 'index.json'), suffix: '/index.js' },
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.source) || !fs.statSync(candidate.source).isFile()) continue;
    if (specifier.endsWith('.json') || specifier.endsWith('.ts')) {
      return specifier.replace(/\.(?:json|ts)$/, '.js');
    }
    return `${specifier}${candidate.suffix}`;
  }

  throw new Error(`unresolved relative runtime specifier ${specifier} from ${importerPath}`);
}

function createEsmSpecifierTransformer(importerPath: string): ts.TransformerFactory<ts.SourceFile> {
  return (context) => {
    const rewrite = (literal: ts.StringLiteralLike): ts.StringLiteral =>
      ts.factory.createStringLiteral(resolveEsmSpecifier(literal.text, importerPath));
    const isTypeOnlyImport = (node: ts.ImportDeclaration): boolean => {
      const importClause = node.importClause;
      if (!importClause) return false;
      if (importClause.isTypeOnly) return true;
      return !importClause.name
        && !!importClause.namedBindings
        && ts.isNamedImports(importClause.namedBindings)
        && importClause.namedBindings.elements.every((element) => element.isTypeOnly);
    };
    const isTypeOnlyExport = (node: ts.ExportDeclaration): boolean =>
      node.isTypeOnly
      || (!!node.exportClause
        && ts.isNamedExports(node.exportClause)
        && node.exportClause.elements.every((element) => element.isTypeOnly));

    const visit: ts.Visitor = (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        if (isTypeOnlyImport(node)) return node;
        return ts.factory.updateImportDeclaration(
          node,
          node.modifiers,
          node.importClause,
          rewrite(node.moduleSpecifier),
          node.assertClause,
        );
      }

      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        if (isTypeOnlyExport(node)) return node;
        return ts.factory.updateExportDeclaration(
          node,
          node.modifiers,
          node.isTypeOnly,
          node.exportClause,
          rewrite(node.moduleSpecifier),
          node.assertClause,
        );
      }

      if (
        ts.isCallExpression(node)
        && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length >= 1
        && ts.isStringLiteralLike(node.arguments[0])
      ) {
        return ts.factory.updateCallExpression(
          node,
          node.expression,
          node.typeArguments,
          [rewrite(node.arguments[0]), ...node.arguments.slice(1)],
        );
      }

      return ts.visitEachChild(node, visit, context);
    };

    return (sourceFile) => ts.visitNode(sourceFile, visit) as ts.SourceFile;
  };
}

function compileModule(moduleName: string, format: 'esm' | 'cjs', packageRoot: string) {
  const inputDir = path.join(packageRoot, moduleName);
  const outputDir = path.join(packageRoot, format === 'esm' ? '_esm' : '_cjs', moduleName);
  
  function processDirectory(currentInputDir: string, currentOutputDir: string, relativePath: string = '') {
    ensureDir(currentOutputDir);
    
    const entries = fs.readdirSync(currentInputDir, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    const jsSources = new Map<string, string[]>();
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith('.d.ts')) continue;
      if (!entry.name.endsWith('.json') && !entry.name.endsWith('.ts')) continue;
      const jsName = entry.name.replace(/\.(?:json|ts)$/, '.js');
      const sources = jsSources.get(jsName) || [];
      sources.push(entry.name);
      jsSources.set(jsName, sources);
    }
    const shadowedJsonSources = new Set<string>();
    for (const [jsName, sources] of jsSources) {
      if (sources.length < 2) continue;
      const jsonSource = sources.find((source) => source.endsWith('.json'));
      const typescriptSource = sources.find((source) => source.endsWith('.ts'));
      if (sources.length !== 2 || !jsonSource || !typescriptSource) {
        throw new Error(
          `module output collision: ${sources.join(', ')} all emit ${path.join(relativePath, jsName)}`,
        );
      }
      shadowedJsonSources.add(jsonSource);
      console.warn(
        `Skipping JSON companion ${path.join(moduleName, relativePath, jsonSource)} because `
        + `${path.join(moduleName, relativePath, typescriptSource)} emits the same `
        + `${path.relative(packageRoot, path.join(currentOutputDir, jsName))}; TypeScript takes precedence.`,
      );
    }
    
    for (const entry of entries) {
      const inputPath = path.join(currentInputDir, entry.name);
      const outputPath = path.join(currentOutputDir, entry.name);
      
      if (entry.isDirectory()) {
        // Recursively process subdirectories
        processDirectory(inputPath, outputPath, path.join(relativePath, entry.name));
      } else if (entry.name.endsWith('.json')) {
        // Copy JSON files directly
        fs.copyFileSync(inputPath, outputPath);

        // Also generate companion JS modules for easier imports
        if (!shadowedJsonSources.has(entry.name)) {
          const jsonSource = fs.readFileSync(inputPath, 'utf8');
          const moduleSource = createJsonModule(jsonSource, format);
          const jsPath = outputPath.replace(/\.json$/, '.js');
          fs.writeFileSync(jsPath, moduleSource);
        }
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        // Compile TypeScript files. This must be a real transpilation because utility modules contain
        // type annotations and bigint literals that cannot be copied verbatim into published .js files.
        const source = fs.readFileSync(inputPath, 'utf8');
        const transformed = ts.transpileModule(source, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2020,
            module: format === 'cjs' ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,
            esModuleInterop: true,
            resolveJsonModule: true,
          },
          fileName: inputPath,
          transformers: format === 'esm' ? { before: [createEsmSpecifierTransformer(inputPath)] } : undefined,
        }).outputText;

        // Write the output file with .js extension
        const jsPath = outputPath.replace(/\.ts$/, '.js');
        fs.writeFileSync(jsPath, transformed);
      } else if (entry.name.endsWith('.d.ts')) {
        // Copy declaration files to _types
        const typesDir = path.join(packageRoot, '_types', moduleName, relativePath);
        ensureDir(typesDir);
        fs.copyFileSync(inputPath, path.join(typesDir, entry.name));
      }
    }
  }
  
  processDirectory(inputDir, outputDir);
}

function buildMainIndex(packageRoot: string) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const version = JSON.stringify(manifest.version);
  // Build simple main index files
  const esmIndex = `// Auto-generated main entry point
export const version = ${version};
`;
  
  const cjsIndex = `// Auto-generated main entry point
exports.version = ${version};
`;
  
  ensureDir(path.join(packageRoot, '_esm'));
  ensureDir(path.join(packageRoot, '_cjs'));
  
  fs.writeFileSync(path.join(packageRoot, '_esm', 'index.js'), esmIndex);
  fs.writeFileSync(
    path.join(packageRoot, '_esm', 'package.json'),
    `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(packageRoot, '_cjs', 'index.js'), cjsIndex);
  
  // Create main type definition
  const typesIndex = `// Auto-generated type definitions
export declare const version: string;
`;
  
  ensureDir(path.join(packageRoot, '_types'));
  fs.writeFileSync(path.join(packageRoot, '_types', 'index.d.ts'), typesIndex);
}

export async function buildModules(packageRoot: string = DEFAULT_PKG_ROOT): Promise<void> {
  console.log('📦 Building modules...');
  
  // Build each module
  for (const module of MODULES) {
    if (fs.existsSync(path.join(packageRoot, module))) {
      console.log(`  Building ${module}...`);
      compileModule(module, 'esm', packageRoot);
      compileModule(module, 'cjs', packageRoot);
    }
  }
  
  // Build main index
  buildMainIndex(packageRoot);
  
  console.log('✅ Build complete');
}

if (require.main === module) {
  buildModules().catch((error) => {
    console.error('❌ Module build failed:', error);
    process.exit(1);
  });
}
