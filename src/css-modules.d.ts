/** Type declaration for CSS Modules imports in browser client code. */
declare module '*.module.css' {
  const classes: { readonly [key: string]: string }
  export default classes
}
