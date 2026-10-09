# scoped-git-add hook: fail-closed confirmation

Job job_c74fafce740a, checked 2026-10-09 against main at 248ddcd.

Finding: `.claude/hooks/scoped-git-add.sh` (blob 11d59813) is already the
fail-closed canonical version (its header says "CANONICAL COPY, ruled
2026-08-16"). It probes interpreters by running them, not by `command -v`, and
blocks on every unexpected outcome. It is not the old 2d4155fb / 2d51b532 blob,
so no replacement was made. A byte-for-byte compare with dustinedwards-info's
copy was not possible: this session has no access to that repo. Whoever has it
can run `git hash-object .claude/hooks/scoped-git-add.sh` here and there and
compare to 11d59813.

Results on this machine (bash, Linux), hook fed the tool payload on stdin:

| Case | Setup | Result |
|------|-------|--------|
| 1 No real Python | `env -i PATH=/nonexistent` | exit 2, "no working Python found (tried python3, python, py)... BLOCKED" |
| 1b Windows-Store-style stub | `python3`/`python` that print a notice and exit 49 | exit 2, same message |
| 2 Python available, planted `git add -A` | normal PATH | exit 2, "Blocked: unscoped git add" |
| 3 Python available, `git add app/routes.ts` | normal PATH | exit 0, allowed |
| 4 Invalid JSON payload | normal PATH | exit 2, "checker exit 4... BLOCKED" |

Change made: `.gitattributes` now pins `.claude/hooks/*.sh text eol=lf`, as the
job asked (the global `* text=auto eol=lf` already normalised them).
