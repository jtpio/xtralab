// jupyter-builder runs `jlpm` in an extension folder that has no node_modules
// folder. With the hoisted pnpm layout, the dependencies are only at the root.
import { mkdirSync, readdirSync } from 'node:fs';

const packages = new URL('../packages/', import.meta.url);
for (const name of readdirSync(packages)) {
  mkdirSync(new URL(`${name}/node_modules`, packages), { recursive: true });
}
