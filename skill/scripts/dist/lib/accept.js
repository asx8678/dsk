// Settling a session's work: dsk accept and dsk reject, the worktrees a run works in, and the lock that keeps one
// in-place run per tree.
const fs = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');
import { Fail, G, STATE, dumps, flock, get, print, runSync, sha256 } from './base.js';
import { chooseProfile, close, drive, resume, slurp } from './commands.js';
import { git, scope, snapshot, tree } from './gates.js';
import { matcher } from './glob.js';
import { workerDiff } from './reports.js';
/** Remove a session's worktree and branch. Best effort: either may already be gone. */
export function removeWorktree(head) {
    for (const args of [['worktree', 'remove', '--force', head.workdir], ['branch', '-D', `dsk/${head.id}`]])
        runSync('git', args, { cwd: head.root });
}
/** One dsk process at a time may change a tree in place: a run undoes what leaves its scope while its scripts
 * execute, and that must never be another run's work. A worktree run needs this only when `accept` applies it. */
export function treeLock(root) {
    fs.mkdirSync(STATE, { recursive: true });
    const name = 'tree-' + sha256(String(root)).slice(0, 12);
    return flock(path.join(STATE, name), 'another dsk run is working in this tree: wait for it, or use --worktree');
}
/** The --allow patterns that name paths git ignores. Each is tried on a sample path, the pattern with an `x` in
 * place of every wildcard, so `docs/*.md` is asked as `docs/x.md`: a rule may ignore a folder and spare some of its
 * files. The sample need not exist. */
export function ignoredPatterns(root, globs) {
    const found = [];
    for (const pattern of globs) {
        const sample = String(pattern).replace(/\*+|\?|\[[^\]]*\]/g, 'x');
        if (runSync('git', ['check-ignore', '-q', '--', sample], { cwd: root }).code === 0)
            found.push(pattern);
    }
    return found;
}
/** A worktree hands in only what git tracks or would track: accept applies a git diff and the worktree is then
 * deleted, so a file written to an ignored path there is lost without a word. Such a task has to run in place. */
export function refuseIgnored(root, globs) {
    const found = ignoredPatterns(root, globs);
    if (found.length)
        throw new Fail(`--allow ${found.join(', ')} names paths git ignores, and a worktree run cannot hand those in: dsk accept applies only what git tracks, and the worktree is then deleted. Run this task without --worktree`);
}
/** A worktree at `workdir`, on branch dsk/<id>, holding the main tree as it is now, uncommitted state and all. */
export function makeWorktree(s, root, workdir) {
    if (runSync('git', ['-C', root, 'rev-parse', '--verify', '-q', 'HEAD']).code)
        throw new Fail('--worktree needs a commit to start from, and this repository has none: '
            + 'make a first commit (git add -A && git commit -m start), or run without --worktree');
    const seed = git(root, ['diff', '--binary', 'HEAD', snapshot(root, path.join(s.dir, 'index.main'))]);
    git(root, ['worktree', 'add', '-q', '-b', `dsk/${s.id}`, workdir, 'HEAD']);
    if (seed)
        git(workdir, ['apply'], { stdin: seed });
}
export function cmdAccept(args, cfg) {
    const s = resume(args.id, 'accept');
    const st = s.last('state');
    const head = s.head;
    let count = st.changed.length;
    let now = null;
    let applied = null;
    let saved = '';
    const late = [];
    if (head.worktree) {
        s.treeLock = treeLock(head.root);
        let patch = workerDiff(s, ['--binary']);
        if (fs.existsSync(head.workdir) && fs.statSync(head.workdir).isDirectory() && get(st, 'end')) {
            // The lead can edit the worktree, with a gofmt or a one-line fix: apply the worktree as it stands.
            const allowed = matcher(scope(s).allow);
            now = tree(s);
            const start = scope(s).start;
            const worker = st.changed.map((entry) => entry[2]);
            const differ = (a, b) => String(git(head.root, ['diff', '--name-only', '--no-renames', '-z', a, b])).split('\0').filter((p) => p);
            // The lead's edits are what moved after the last stop, and what differs from the start without being the
            // worker's: an edit made between two rounds is already in the tree of the last stop.
            const after = [...new Set([...differ(st.end, now),
                    ...differ(start, now).filter((p) => !worker.includes(p))])];
            const inside = after.filter((p) => allowed(p));
            const outside = after.filter((p) => !allowed(p));
            if (outside.length) { // not mine to apply, but it must not die with the worktree either
                const kept = path.join(s.dir, 'late.patch');
                saved = String(git(head.root, ['diff', '--binary', start, now, '--',
                    ...outside.map((p) => ':(literal)' + p)]));
                late.push(`late:    not applied, outside --allow: ${outside.join(', ')} (kept as ${kept})`);
            }
            if (inside.length) {
                const files = [...new Set([...st.changed.map((entry) => entry[2]), ...inside])];
                const paths = files.map((file) => ':(literal)' + file);
                patch = git(head.root, ['diff', '--binary', start, now, '--', ...paths]);
                applied = String(git(head.root, ['diff', '--numstat', '--no-renames', '-z', start, now, '--', ...paths]))
                    .split('\0').filter((entry) => entry).map((entry) => entry.split('\t'));
                late.unshift(`late:    included your edits in the worktree: ${inside.join(', ')}`);
            }
        }
        try {
            if (patch)
                git(head.root, ['apply'], { stdin: patch });
        }
        catch (e) { // git apply is all-or-nothing, so the main tree is untouched
            if (e instanceof Fail)
                throw new Fail(`conflict, nothing was applied and the session is still open (${e.message})`);
            throw e;
        }
        if (saved) { // written only once nothing can fail any more, just before the worktree goes
            fs.writeFileSync(path.join(s.dir, 'late.patch'), saved, 'utf8');
        }
        removeWorktree(head);
    }
    if (applied !== null) { // close() copies the last state, which must say what was applied, not what the worker left
        st.end = now;
        st.changed = applied;
        count = applied.length;
    }
    close(s, 'accepted');
    const where = head.worktree ? 'applied to your working tree, uncommitted' : 'already in your working tree';
    print(`dsk ${s.id} · accepted · ${count} file${count === 1 ? '' : 's'} ${where}`);
    for (const line of late)
        print(line);
    return 0;
}
export async function cmdReject(args, cfg) {
    if ((Number(Boolean(args.text)) + Number(Boolean(args.brief)) + Number(Boolean(args.drop))) !== 1)
        throw new Fail('give the defects as "text" or with --brief FILE, or --drop to discard the work, not two of them');
    const text = args.text || (args.brief ? slurp(args.brief) : '');
    if (args.drop && args.profile)
        throw new Fail('--profile chooses the provider of the next round, and --drop has none');
    if (args.drop && args.max_turns)
        throw new Fail('--max-turns sets the turn limit of the next round, and --drop has none');
    if (!args.drop) {
        const s = resume(args.id, 'reject');
        chooseProfile(s, cfg, args.profile);
        s.add('reject', { text, max_turns: args.max_turns ?? null });
        s.add('round');
        let extra = '\n\nthe lead reviewed this and rejected it. Fix these defects:\n' + text;
        if (args.max_turns)
            extra += `\n\nturn limit for this round: ${args.max_turns}`;
        return await drive(s, cfg, extra);
    }
    const s = resume(args.id, 'drop');
    const head = s.head;
    if (head.worktree)
        removeWorktree(head);
    else if (head.start) {
        const patch = workerDiff(s, ['--binary']);
        try {
            if (patch)
                git(head.root, ['apply', '-R'], { stdin: patch });
        }
        catch (e) {
            if (e instanceof Fail)
                throw new Fail(`the tree has moved since the run, nothing was reverted (${e.message})`);
            throw e;
        }
    }
    close(s, 'dropped');
    print(G.json ? dumps({ id: s.id, status: 'dropped' })
        : `dsk ${s.id} · dropped · the worker's changes were discarded`);
    return 0;
}
