import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");
const options = {
  entryPoints: ["main.ts"],
  outfile: "main.js",
  bundle: true,
  format: "cjs",
  external: ["obsidian"],
  target: "es2020",
  minify: !watch,
  sourcemap: watch ? "inline" : false,
};

if (watch) {
  const builder = await context(options);
  await builder.watch();
} else {
  await build(options);
}
