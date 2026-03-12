#!/usr/bin/env ts-node

import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';

// Generate declarations inside the built package directory
const PACKAGE_ROOT = path.resolve(__dirname, '..', 'dist');

// Directories to process
const DIRECTORIES_TO_PROCESS = [
  'addresses',
  'constants',
  'paymentMethods',
  'currencies',
  'utils',
  'abis',
  'types'
];

/**
 * Find all index.ts files in the given directories
 */
function findIndexFiles(dirs: string[]): string[] {
  const indexFiles: string[] = [];
  
  for (const dir of dirs) {
    const dirPath = path.join(PACKAGE_ROOT, dir);
    if (!fs.existsSync(dirPath)) continue;
    
    // Find index.ts in root of directory
    const rootIndex = path.join(dirPath, 'index.ts');
    if (fs.existsSync(rootIndex)) {
      indexFiles.push(rootIndex);
    }
    
    // Find index.ts in subdirectories (for abis/*)
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subIndex = path.join(dirPath, entry.name, 'index.ts');
        if (fs.existsSync(subIndex)) {
          indexFiles.push(subIndex);
        }
      }
    }
  }
  
  return indexFiles;
}

/**
 * Compile TypeScript files to .d.ts declarations only
 */
function generateDeclarations(files: string[]): void {
  const options: ts.CompilerOptions = {
    declaration: true,
    emitDeclarationOnly: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    skipLibCheck: true,
    allowSyntheticDefaultImports: true
  };
  
  const host = ts.createCompilerHost(options);
  const program = ts.createProgram(files, options, host);
  const emitResult = program.emit();
  
  const allDiagnostics = ts
    .getPreEmitDiagnostics(program)
    .concat(emitResult.diagnostics);
  
  // Only show errors, not warnings
  const errors = allDiagnostics.filter(d => d.category === ts.DiagnosticCategory.Error);
  
  if (errors.length > 0) {
    errors.forEach(diagnostic => {
      if (diagnostic.file) {
        const { line, character } = ts.getLineAndCharacterOfPosition(diagnostic.file, diagnostic.start!);
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
        console.error(`${diagnostic.file.fileName} (${line + 1},${character + 1}): ${message}`);
      } else {
        console.error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      }
    });
    throw new Error('Failed to generate type declarations');
  }
}

/**
 * Also compile protocolUtils.ts to .d.ts
 */
function generateProtocolUtilsTypes(): void {
  const protocolUtilsPath = path.join(PACKAGE_ROOT, 'utils', 'protocolUtils.ts');
  if (fs.existsSync(protocolUtilsPath)) {
    generateDeclarations([protocolUtilsPath]);
  }
}

/**
 * Main function
 */
async function main() {
  console.log('🔧 Generating .d.ts declaration files...');
  
  try {
    // Find all index.ts files
    const indexFiles = findIndexFiles(DIRECTORIES_TO_PROCESS);
    console.log(`📝 Found ${indexFiles.length} index.ts files to process`);
    
    if (indexFiles.length > 0) {
      // Generate declarations for index files
      generateDeclarations(indexFiles);
      console.log('✅ Generated .d.ts for index files');
    }
    
    // Also generate for protocolUtils.ts
    generateProtocolUtilsTypes();
    console.log('✅ Generated .d.ts for protocolUtils');
    
    console.log('✅ Type generation complete');
  } catch (error) {
    console.error('❌ Type generation failed:', error);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('❌ Unexpected error:', err);
  process.exit(1);
});
