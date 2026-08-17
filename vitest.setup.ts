import "@testing-library/jest-dom/vitest";

// jsdom implements neither scrollIntoView nor matchMedia — stub the ones this codebase actually
// calls so component/hook tests that trigger them don't crash. Guarded because this setup file
// also runs for the (much more numerous) node-environment API/lib tests, where `Element`/`window`
// don't exist at all.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
