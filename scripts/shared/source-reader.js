import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// NOTE: this file intentionally lives under scripts/shared/ (not scripts/) so that
// static-checks.js's readdir-based auto-discovery (which runs every scripts/check-*.js)
// never picks it up as a check to execute.

async function collectLibFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      files.push(...(await collectLibFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Lists the backend source files that make up the server runtime: server.js plus
 * any lib/**\/*.js modules (the lib/ directory is optional and simply skipped while
 * it does not exist yet). Sorted by path for deterministic output.
 *
 * Exposed separately from readServerSource() for checks that need per-file
 * granularity (e.g. line-numbered scanning) instead of one concatenated string.
 */
export async function listServerSourceFiles() {
  const libFiles = await collectLibFiles("lib");
  return ["server.js", ...libFiles].sort();
}

/**
 * Reads server.js plus any lib/**\/*.js modules and concatenates them (sorted by
 * path) into a single source string.
 *
 * This is the single point of truth check-*.js scripts use to inspect backend
 * source code via String.includes()/regex snippet assertions. When server.js is
 * eventually split into server.js + lib/*.js modules, those checks keep working
 * unmodified because they search the combined string rather than a single file.
 */
// This repo has no .gitattributes and its tracked files are checked out with CRLF
// line endings on Windows. A number of check-*.js scripts locate code with
// LF-anchored regexes (e.g. `\n  };\n}`), which silently fail to match against raw
// CRLF content. Normalizing here means every check-*.js script that reads source
// through this module sees consistent `\n` line endings, regardless of the host
// platform's checkout behavior.
function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, "\n");
}

export async function readServerSource() {
  const files = await listServerSourceFiles();
  const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
  return contents.map(normalizeLineEndings).join("\n");
}

/**
 * Reads the frontend bundle source. Kept as a single-file read today
 * (public/app.js), but funneled through one function so that if the frontend
 * is ever split into modules, only this function needs to change.
 */
export async function readFrontendSource() {
  const content = await readFile("public/app.js", "utf8");
  return normalizeLineEndings(content);
}

// Keywords that put the parser in "expression expected next" position, so a
// `/` immediately following one of them (possibly across whitespace/comments)
// starts a regex literal rather than being a division operator. This is the
// same classic heuristic real-world lightweight JS tokenizers (e.g. most
// "strip comments" utilities and simple minifiers) use to disambiguate `/`
// without a full parser. `true`/`false`/`null`/`this`/`super`/plain
// identifiers are deliberately NOT in this set — they are values, so a `/`
// right after them is division.
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "do", "else", "yield", "case", "await", "default", "extends"
]);

function isWordChar(ch) {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_" || ch === "$";
}

/**
 * Strips `//` line comments and `/* *\/` block comments from a JS source
 * string, leaving everything else — including string/template literal
 * contents AND regex literal contents — intact.
 *
 * This exists because several check-*.js scripts assert a substring exists in
 * the *executable* source via `serverSource.includes(...)`, but a substring
 * that only appears inside a comment (e.g. a docstring that happens to mention
 * the exact call shape being asserted) satisfies `.includes()` just as well as
 * real code does — silently turning the assertion into a tautology that can
 * never fail no matter how badly the real implementation regresses. Running
 * a check's target snippets against `stripComments(source)` instead closes
 * that gap: a comment-only occurrence of the snippet disappears, so the
 * assertion can only pass if the snippet is present in real code.
 *
 * Implemented as a single-pass character scanner that tracks four kinds of
 * "we are inside X, comment-detection is suspended" spans:
 *   - a string literal (`'...'` or `"..."`),
 *   - a template literal (`` `...` ``),
 *   - a regex literal (`/.../flags`), and
 *   - (transiently) a comment itself, while consuming it.
 *
 * The regex-literal handling exists because without it, a regex containing an
 * odd/awkwardly-paired number of quote characters — e.g. this repo's own
 * `lib/safety.js`'s `SENSITIVE_VALUE_PATTERN = /...["']?...(?:"[^"]{8,}"|'[^']{8,}'|...)/i`
 * — desyncs a naive quote-counting scanner: it sees the `"` inside `["']?` and
 * (wrongly, since it's regex syntax, not a string delimiter) enters "inside a
 * double-quoted string" mode, then hunts for the next `"` to close it,
 * swallowing arbitrary amounts of subsequent source (potentially including
 * real comments, and in the worst case never finding a "closing" quote before
 * EOF) as if it were string content. A `/` is only treated as the start of a
 * regex literal when the previous significant token indicates an expression
 * is expected next (see REGEX_PRECEDING_KEYWORDS and the operator/punctuation
 * handling below) — otherwise it is division and left untouched. Inside a
 * recognized regex literal, quotes are just literal pattern characters (never
 * open a string span), `\/` does not end the literal, and `/` inside an
 * unclosed `[...]` character class does not end the literal either (e.g.
 * `/[/]/ ` is one complete regex, not "regex `/[/`, stray `]`, regex `/ /`").
 *
 * Deliberately still not a full JS parser: template-literal `${...}`
 * interpolations are treated as opaque string content rather than re-entering
 * "code" mode. That's fine for this repo's check-*.js use, where the asserted
 * snippets live in plain statements/object literals, not inside template
 * interpolations.
 *
 * Fails loudly instead of silently on a parse desync: if the scanner reaches
 * the end of `source` still "inside" an unterminated string, template
 * literal, or block comment, that means some construct in `source` was
 * misread (most likely a regex literal this heuristic still doesn't handle,
 * or genuinely malformed input) — returning the partially-scanned result in
 * that case would silently reproduce exactly this class of bug, so this
 * throws instead. (An unterminated *regex* never reaches this final check: it
 * is caught and safely reinterpreted as a division `/` — see the "not a
 * regex after all" fallback inline below — because real code sometimes
 * legitimately has ambiguous `/` sequences the heuristic guesses wrong on,
 * whereas a string/template/block-comment left open through EOF has no such
 * benign explanation.)
 *
 * Only used by check scripts that opt into it — readServerSource() and
 * readFrontendSource() above are completely unchanged, so the ~20 other
 * check-*.js scripts that rely on their existing (comments-included)
 * behavior are unaffected. For multi-file use, prefer readServerSourceStripped()
 * below (strips each file independently, then joins) rather than calling
 * stripComments() on an already-concatenated multi-file string: one file's
 * content can never desync another's that way, even if this heuristic is
 * ever wrong about some construct.
 *
 * @param {string} source
 * @param {{ sourceName?: string }} [options] - sourceName is included in any
 *   thrown error message, so a per-file caller (readServerSourceStripped())
 *   can point at exactly which file desynced the scanner.
 */
export function stripComments(source, options = {}) {
  const sourceLabel = options.sourceName ? ` in ${options.sourceName}` : "";
  const text = String(source ?? "");
  const length = text.length;
  let out = "";
  let i = 0;
  // Whether the *previous* significant token was value-producing (identifier,
  // number, string, template, regex, `)`, `]`) — if so, the next bare `/` is
  // division. Starts false: a `/` at the very start of a file is a regex.
  let prevTokenAllowsDivision = false;
  let currentWord = "";

  function flushWord() {
    if (!currentWord) return;
    prevTokenAllowsDivision = !REGEX_PRECEDING_KEYWORDS.has(currentWord);
    currentWord = "";
  }

  while (i < length) {
    const ch = text[i];

    if (isWordChar(ch)) {
      currentWord += ch;
      out += ch;
      i++;
      continue;
    }
    // Any non-word character ends whatever identifier/keyword/number run
    // (if any) was being accumulated.
    flushWord();

    const nextCh = i + 1 < length ? text[i + 1] : "";

    if (ch === "/" && nextCh === "/") {
      i += 2;
      while (i < length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && nextCh === "*") {
      i += 2;
      let closedComment = false;
      while (i < length) {
        if (text[i] === "*" && text[i + 1] === "/") { closedComment = true; break; }
        i++;
      }
      if (!closedComment) {
        throw new Error(`stripComments: unterminated block comment${sourceLabel}`);
      }
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      let closedString = false;
      while (i < length) {
        const c = text[i];
        if (c === "\\") {
          out += c;
          i++;
          if (i < length) {
            out += text[i];
            i++;
          }
          continue;
        }
        out += c;
        i++;
        if (c === quote) { closedString = true; break; }
      }
      if (!closedString) {
        const kind = quote === "`" ? "template literal" : "string literal";
        throw new Error(`stripComments: unterminated ${kind}${sourceLabel}`);
      }
      prevTokenAllowsDivision = true;
      continue;
    }
    if (ch === "/" && !prevTokenAllowsDivision) {
      // Candidate regex literal. Tentatively scan ahead (without touching
      // `out`/`i` yet) to find its unescaped, not-inside-a-character-class
      // closing `/`. A raw newline before that point means this was never a
      // real regex literal (JS regex literals cannot contain literal
      // newlines) — most likely a division `/` this heuristic misjudged —
      // so fall back to treating just the opening `/` as division and let
      // the main loop re-scan whatever follows normally.
      let j = i + 1;
      let inCharClass = false;
      let closed = false;
      while (j < length) {
        const c = text[j];
        if (c === "\\") { j += 2; continue; }
        if (c === "\n") break;
        if (c === "[") { inCharClass = true; j++; continue; }
        if (c === "]") { inCharClass = false; j++; continue; }
        if (c === "/" && !inCharClass) { closed = true; j++; break; }
        j++;
      }
      if (closed) {
        let k = j;
        while (k < length && /[a-zA-Z]/.test(text[k])) k++;
        out += text.slice(i, k);
        i = k;
        prevTokenAllowsDivision = true;
        continue;
      }
      // Not a regex after all: emit the `/` as a plain (division) character.
      out += ch;
      i++;
      prevTokenAllowsDivision = false;
      continue;
    }
    if (ch === ")" || ch === "]") {
      prevTokenAllowsDivision = true;
      out += ch;
      i++;
      continue;
    }
    if ((ch === "+" && nextCh === "+") || (ch === "-" && nextCh === "-")) {
      // `++`/`--` (postfix or prefix increment/decrement): JS's lexer uses
      // maximal munch, so two adjacent identical `+`/`-` characters are
      // always ONE `++`/`--` token, never two separate unary operators —
      // that's why this two-char lookahead (rather than counting a longer
      // run of signs, which would also have to reason about things like
      // `a - -b`) is enough to disambiguate. What matters for division-vs-
      // regex classification is whether this token is POSTFIX or PREFIX,
      // which is exactly what prevTokenAllowsDivision already told us about
      // the token immediately before this one:
      //   - postfix (`x++`, `a.b++`): the previous token was already a
      //     value (prevTokenAllowsDivision === true), and `x++` evaluates
      //     to that value — so a `/` right after this token is division.
      //   - prefix (`++x`, `++ x`): the previous token was NOT a value
      //     (prevTokenAllowsDivision === false), and prefix `++`/`--` still
      //     awaits its operand — so we conservatively leave
      //     prevTokenAllowsDivision false, same as any other punctuation.
      //     (In practice the operand is an identifier immediately after,
      //     which sets the correct state itself via flushWord(); this only
      //     matters for the rare `++ /* comment */ x` shape.)
      const isPostfix = prevTokenAllowsDivision;
      out += ch;
      out += nextCh;
      i += 2;
      prevTokenAllowsDivision = isPostfix;
      continue;
    }
    // Every other punctuation/operator character (including `/` when
    // prevTokenAllowsDivision is true, i.e. real division) and whitespace.
    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") {
      prevTokenAllowsDivision = false;
    }
    out += ch;
    i++;
  }
  flushWord();
  return out;
}

/**
 * Like readServerSource(), but strips comments from EACH file independently
 * before joining them — never on the already-concatenated multi-file string.
 *
 * This matters because stripComments() is a heuristic, not a full parser: if
 * it ever misreads some construct in one file badly enough to desync its
 * internal state, that desync must stay contained to that one file's output.
 * Stripping the whole concatenated blob in one pass would let a single file's
 * parse error corrupt (or silently swallow real comments from) every file
 * concatenated after it — which is exactly how this function's predecessor
 * bug manifested: a desync inside lib/safety.js's SENSITIVE_VALUE_PATTERN
 * regex left the scanner "inside a string" past that file's end, silently
 * preserving a real comment block in the NEXT file (lib/store.js) in the
 * concatenated output. Stripping per-file, then joining, makes that
 * structurally impossible: each stripComments() call only ever sees one
 * file's content, so it can only succeed or throw — never leak state into
 * the next file.
 */
export async function readServerSourceStripped() {
  const files = await listServerSourceFiles();
  const contents = await Promise.all(files.map(async (file) => {
    const raw = normalizeLineEndings(await readFile(file, "utf8"));
    return stripComments(raw, { sourceName: file });
  }));
  return contents.join("\n");
}
