// Type declaration for importing SVG files as raw strings. The labextension
// build (@jupyter/builder) loads `.svg` imported from compiled `.ts` files
// with `asset/source`, i.e. the file's markup as a string — LabIcon's format.
declare module '*.svg' {
  const value: string;
  export default value;
}
