import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import dts from 'vite-plugin-dts';

// `//#region`/`//#endregion`, which rolldown inserts at module boundaries, fall outside the
// comments setting's scope, so this strips them separately
const stripRegionMarkers = (): Plugin => ({
  name: 'strip-region-markers',
  renderChunk(code) {
    return code.replace(/^\/\/#(?:region|endregion).*\n/gm, '');
  },
});
const libName = 'StickyScrollTrigger';
// Never emits any comment other than the license notice (JSDoc, etc.), even in the unminified build
const nonMinifiedComments = { legal: true, annotation: false, jsdoc: false } as const;
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as {
  name: string;
  version: string;
  author: string;
  license: string;
  homepage: string;
};
// Shared across all 4 JS outputs and the bundled .d.ts, so bumping the package version never
// requires touching this file
// The `@license` marker keeps this banner from being stripped by the minified outputs' minifier,
// which otherwise discards any comment that isn't tagged as a legal notice
const banner = `/*!\n * @license\n * ${libName} v${pkg.version}\n * Copyright (c) ${new Date().getFullYear()} ${pkg.author}\n * Released under the ${pkg.license} License\n * ${pkg.homepage}\n */`;

export default defineConfig({
  publicDir: false,
  plugins: [
    stripRegionMarkers(),
    dts({
      tsconfigPath: 'tsconfig.build.json',
      bundleTypes: true,
      // The bundled .d.ts references ScrollTrigger.Vars unconditionally as a global type, but API
      // Extractor never carries the source's `/// <reference types="gsap" />` through to the
      // output, so this inserts it directly at the top here (so it still resolves
      // gsap/ScrollTrigger even when copied somewhere standalone that never imports them).
      beforeWriteFile: (filePath, content) => {
        const withReference = content.includes('/// <reference types="gsap" />')
          ? content
          : `/// <reference types="gsap" />\n${content}`;
        // A source module's leading comment can sometimes leak into the bundle's leading type
        // definition, so this strips every comment but the license notice from the .d.ts too
        // (matching the policy of the JS side's comments setting).
        const withoutComments = withReference
          .replace(/\/\*\*?[\s\S]*?\*\//g, (comment) =>
            /@license|@preserve/.test(comment) ? comment : '',
          )
          .replace(/\n{3,}/g, '\n\n');

        return { filePath, content: `${banner}\n${withoutComments}` };
      },
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      // The JS output's own file name is decided by the rollupOptions.output array. fileName
      // here is only ever referenced by vite-plugin-dts to name the bundled .d.ts (it's never
      // used for the actual output).
      fileName: 'StickyScrollTrigger',
    },
    rollupOptions: {
      // Passing an array here means the JS output's file name is decided by entryFileNames here,
      // not build.lib.formats/fileName (build.lib.fileName still only applies to the bundled
      // .d.ts name). rolldown can specify minify independently per output
      // (OutputOptions.minify), so this emits both the unminified and minified builds together
      // in this single vite build.
      output: [
        {
          format: 'es',
          entryFileNames: 'StickyScrollTrigger.js',
          minify: 'dce-only',
          topLevelVar: false,
          comments: nonMinifiedComments,
          banner,
        },
        {
          format: 'iife',
          entryFileNames: 'StickyScrollTrigger.global.js',
          name: libName,
          minify: 'dce-only',
          topLevelVar: false,
          comments: nonMinifiedComments,
          banner,
        },
        {
          format: 'es',
          entryFileNames: 'StickyScrollTrigger.min.js',
          minify: true,
          topLevelVar: false,
          comments: { legal: true },
          banner,
        },
        {
          format: 'iife',
          entryFileNames: 'StickyScrollTrigger.global.min.js',
          name: libName,
          minify: true,
          topLevelVar: false,
          comments: { legal: true },
          banner,
        },
      ],
    },
  },
});
