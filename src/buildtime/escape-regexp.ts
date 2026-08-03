// Regex-metacharacter escaping, shared by the build-time source guards.
//
// WHY THIS EXISTS. Two guards build a `RegExp` by interpolating a constant into
// a pattern. `container-write-invariant.ts` interpolates an identifier;
// `popup-only-invariant.ts` interpolates a manifest resource pattern. An
// interpolated value that carries a metacharacter stops being matched literally,
// and a guard that silently stops matching is worse than no guard — it reports
// "clean" for a tree it is no longer inspecting.
//
// Both had their own answer to this: `popup-only-invariant.ts` escaped inline,
// and `container-write-invariant.ts` did not escape at all. This is the single
// implementation both now use.

/**
 * `literal` with every regex metacharacter escaped EXCEPT `*` and `?`.
 *
 * WHAT IS ESCAPED: `.` `+` `^` `$` `{` `}` `(` `)` `|` `[` `]` `\`
 *
 * WHAT IS NOT, AND WHY THE NAME SAYS SO. `*` is left alone because the caller
 * that needs it — `globToRegExp` in `popup-only-invariant.ts` — translates it
 * into `.*` as deliberate glob semantics immediately afterwards. Escaping it
 * here would turn a Chrome wildcard pattern into a literal asterisk and the
 * popup-only guard would stop matching the thing it exists to catch. `?` is
 * excluded on the same reasoning: it is a glob character, and that caller strips
 * it before this is reached.
 *
 * THE CONSEQUENCE FOR THE OTHER CALLER, stated so it is not rediscovered: a
 * value containing `*` or `?` is NOT made literal by this function. That is safe
 * for an identifier — JavaScript identifiers admit only `[A-Za-z0-9_$]`, of
 * which `$` alone is a metacharacter, and `$` is escaped. A future caller
 * passing arbitrary text that may contain `*` or `?` needs a complete escaper,
 * not this one.
 */
export function escapeRegExpExceptWildcard(literal: string): string {
  return literal.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}
