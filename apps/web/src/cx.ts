/**
 * Joins class names, dropping anything falsy.
 *
 * Exists because of a genuine type/runtime hazard rather than for
 * convenience: Next types a CSS-module import through an index signature, and
 * this repo compiles with `noUncheckedIndexedAccess`, so every `styles.foo`
 * is `string | undefined`. Interpolating one straight into a template literal
 * type-checks and then renders the literal class name "undefined" if the rule
 * is ever renamed or removed. This makes that case disappear instead.
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === "string" && p !== "").join(" ");
}
