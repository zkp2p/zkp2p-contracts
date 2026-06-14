#!/usr/bin/env ts-node
import 'ts-node/register/transpile-only';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const PKG_ROOT = path.resolve(__dirname, '..');

// Modules to build
const MODULES = ['addresses', 'abis', 'constants', 'paymentMethods', 'currencies', 'oracleFeeds', 'networks', 'types', 'utils'];

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

function rewriteEsmSpecifier(specifier: string): string {
  if (specifier.endsWith('.json')) {
    return specifier.replace(/\.json$/, '.js');
  }
  if (/\.(js|mjs|cjs)$/.test(specifier)) {
    return specifier;
  }
  return `${specifier}.js`;
}

function rewriteEsmRelativeImports(source: string): string {
  return source
    .replace(/(from\s+["'])(\.{1,2}\/[^"']+)(["'])/g, (_match, prefix, specifier, suffix) => {
      return `${prefix}${rewriteEsmSpecifier(specifier)}${suffix}`;
    })
    .replace(/(import\s+["'])(\.{1,2}\/[^"']+)(["'])/g, (_match, prefix, specifier, suffix) => {
      return `${prefix}${rewriteEsmSpecifier(specifier)}${suffix}`;
    });
}

function compileModule(moduleName: string, format: 'esm' | 'cjs') {
  const inputDir = path.join(PKG_ROOT, moduleName);
  const outputDir = path.join(PKG_ROOT, format === 'esm' ? '_esm' : '_cjs', moduleName);
  
  function processDirectory(currentInputDir: string, currentOutputDir: string, relativePath: string = '') {
    ensureDir(currentOutputDir);
    
    const entries = fs.readdirSync(currentInputDir, { withFileTypes: true });
    
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
        const jsonSource = fs.readFileSync(inputPath, 'utf8');
        const moduleSource = createJsonModule(jsonSource, format);
        const jsPath = outputPath.replace(/\.json$/, '.js');
        fs.writeFileSync(jsPath, moduleSource);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        // Compile TypeScript files
        const source = fs.readFileSync(inputPath, 'utf8');

        let transformed = ts.transpileModule(source, {
          compilerOptions: {
            esModuleInterop: true,
            module: format === 'esm' ? ts.ModuleKind.ES2020 : ts.ModuleKind.CommonJS,
            moduleResolution: ts.ModuleResolutionKind.NodeJs,
            resolveJsonModule: true,
            target: ts.ScriptTarget.ES2020,
          },
          fileName: inputPath,
        }).outputText;

        if (format === 'esm') {
          transformed = rewriteEsmRelativeImports(transformed);
        }

        // Write the output file with .js extension
        const jsPath = outputPath.replace(/\.ts$/, '.js');
        fs.writeFileSync(jsPath, transformed);
      } else if (entry.name.endsWith('.d.ts')) {
        // Copy declaration files to _types
        const typesDir = path.join(PKG_ROOT, '_types', moduleName, relativePath);
        ensureDir(typesDir);
        fs.copyFileSync(inputPath, path.join(typesDir, entry.name));
      } else if (entry.name.endsWith('.cjs') || entry.name.endsWith('.mjs')) {
        // Copy generated wrapper files to output directory
        fs.copyFileSync(inputPath, outputPath);
      }
    }
  }
  
  processDirectory(inputDir, outputDir);
}

function buildMainIndex() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
  const version = JSON.stringify(packageJson.version);

  // Build simple main index files
  const esmIndex = `// Auto-generated main entry point
export const version = ${version};
`;
  
  const cjsIndex = `// Auto-generated main entry point
exports.version = ${version};
`;
  
  ensureDir(path.join(PKG_ROOT, '_esm'));
  ensureDir(path.join(PKG_ROOT, '_cjs'));
  
  fs.writeFileSync(path.join(PKG_ROOT, '_esm', 'index.js'), esmIndex);
  fs.writeFileSync(path.join(PKG_ROOT, '_cjs', 'index.js'), cjsIndex);
  
  // Create main type definition
  const typesIndex = `// Auto-generated type definitions
export declare const version: string;
`;
  
  ensureDir(path.join(PKG_ROOT, '_types'));
  fs.writeFileSync(path.join(PKG_ROOT, '_types', 'index.d.ts'), typesIndex);
}

export async function buildModules(): Promise<void> {
  console.log('📦 Building modules...');
  
  // Build each module
  for (const module of MODULES) {
    if (fs.existsSync(path.join(PKG_ROOT, module))) {
      console.log(`  Building ${module}...`);
      compileModule(module, 'esm');
      compileModule(module, 'cjs');
    }
  }
  
  // Build main index
  buildMainIndex();
  
  console.log('✅ Build complete');
}

if (require.main === module) {
  buildModules().catch((error) => {
    console.error('❌ Module build failed:', error);
    process.exit(1);
  });
}
