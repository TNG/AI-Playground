# Sandboxing Claude Code — Reusable Setup Plan

A template to run Claude Code confined to a single project on Windows 11 Pro,
with the full Electron GUI + NVIDIA/CUDA inference running natively. Designed to
be applied to **multiple projects that stay isolated from each other**.

## Goals

1. **Filesystem confinement** — Claude cannot read or write anything outside its
   own project folder (your profile, SSH keys, other repos, other sandboxed
   projects, credentials).
2. **No pushes to git origin** — Claude cannot write to the remote.
3. *(Bonus)* **No harmful downloads on the main OS** — best-effort mitigation.

## Chosen approach: one dedicated low-privilege Windows user per project

Each project gets its **own** standard (non-admin) Windows account. Claude Code,
and everything it spawns, runs under that account. Windows' NTFS ACLs and
per-identity credential isolation enforce the boundaries; the GUI and NVIDIA GPU
work natively because everything runs on the host.

**Why one user per project:** a user can read every folder it's granted. If two
projects shared one account, they wouldn't be isolated from each other. A separate
account per project means project A's Claude has no ACL entry on project B — and
can't even enumerate the sibling folders.

### What this delivers vs. what it doesn't

| Goal | Status | Notes |
|------|--------|-------|
| 1. Can't reach *your* files | **Met** | Windows blocks the sandbox user from `C:\Users\<you>\`. |
| 1b. Can't reach *other projects* | **Met** | Each project folder grants only its own user; the shared root grants none, so siblings can't be listed. |
| 1c. *Only* the project, nothing else at all | **Not met** | Sandbox user can still read system dirs (`C:\Program Files`, `C:\Windows`) — the app needs them. Only a VM hides these. |
| 1d. Other drives (`D:`, externals) blocked | **Met via Step 4** | Not automatic — needs explicit Deny ACEs + a removable-storage policy, per user. |
| 2. No push to origin | **Met** | No creds + no SSH key + dead push URL + Claude deny rule. |
| 3. No harmful downloads on main OS | **Mitigated** | Downloads land in the sandbox user's profile, run unprivileged — but same OS/disk. Not eliminated. |

## Key mechanism / mental model

**Confinement = running the process as the restricted user.** If Claude Code is
ever launched from your normal (`TNG`) session, it inherits *your* full access and
none of the isolation applies — silently. The boundary is the per-project sandbox
terminal. This per-launch discipline is the price of the host-based approach.

Your own manual work is **unchanged**: each repo stays accessible to your daily
account, so you edit/commit/push in IntelliJ as usual.

---

## ⚙️ CONFIG — set your values here

Everything below reads from these variables. **This is the only place you edit
your username and paths.**

```powershell
# ── Your real, daily Windows account (run `whoami`, take the part after HOST\).
#    Getting this wrong locks YOU out of your own repo. Set once, reused everywhere.
$me = "TNG"

# ── The shared parent that holds every sandboxed project.
$sandboxRoot = "C:\ClaudeSandbox"

# ── PER-PROJECT values — change these three for each project you onboard.
$proj    = "AI-Playground"                          # short project/folder name
$src     = "C:\Users\$me\repos\AI-Playground"        # where the repo lives TODAY
$sbxUser = "claude-AI-Playground"                    # this project's dedicated user
#   Convention: one user per project, e.g. claude-<Project>. Max 20 chars, no spaces.

# Derived (don't edit):
$dest = "$sandboxRoot\$proj"
```

> To onboard another project later: re-run **Step 3 onward** with a new `$proj`,
> `$src`, and `$sbxUser`. Step 1 (the shared root) is done only once.

---

## Step 1 — One-time: create the shared sandbox root *(elevated PowerShell, as Admin)*

Run this **once, ever.** It creates the parent that holds all projects and grants
access to only SYSTEM, Admins, and you. Sandbox users get **no** access here, so
they can't list or reach each other's projects.

```powershell
New-Item -ItemType Directory -Path $sandboxRoot -Force | Out-Null
$acl = Get-Acl $sandboxRoot
$acl.SetAccessRuleProtection($true, $false)                       # no inheritance from C:\
$acl.Access | ForEach-Object { [void]$acl.RemoveAccessRule($_) }
"SYSTEM","Administrators","$me" | ForEach-Object {
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    $_, "FullControl","ContainerInherit,ObjectInherit","None","Allow"))) }
Set-Acl $sandboxRoot $acl
```

---

## Step 2 — One-time per machine: remove the DACL for the current user *(reference)*

No action — noted only so you know sandbox users rely on Windows' default profile
isolation for `C:\Users\<you>\`. Nothing to configure.

---

## Step 3 — Per project: create the user + relocate the repo *(elevated PowerShell, as Admin)*

Run once per project, after setting the CONFIG block for that project.

```powershell
# 3a. Dedicated standard (non-admin) user for THIS project
$pw = Read-Host -AsSecureString "Set a password for $sbxUser"
New-LocalUser -Name $sbxUser -Password $pw -FullName "Claude Sandbox: $proj" `
              -Description "Confined account for Claude Code on $proj"
Add-LocalGroupMember -Group "Users" -Member $sbxUser              # Users, NOT Administrators

# 3b. Move the repo into the sandbox root
Move-Item $src $dest

# 3c. Drop the repo's old profile ACEs so it inherits the root's (you/admin/system only)
icacls $dest /reset /T /C /Q

# 3d. Grant ONLY this project's user — no other sandbox user gets an ACE here
icacls $dest /grant "${sbxUser}:(OI)(CI)M" /T /C /Q               # M = Modify → can't re-ACL
```

After this: `$sbxUser` reads/writes **only** `$dest`, cannot see `C:\Users\<you>\`,
cannot see or list any other project under `$sandboxRoot`, and cannot change its
own ACLs.

> Update IntelliJ (and any tooling) to open the repo at its new path `$dest`.

---

## Step 4 — Per project: lock down other drives *(elevated PowerShell, as Admin — if you have `D:` / externals)*

Windows defaults are permissive: `BUILTIN\Users` gets Read & Execute on fixed data
drives, and FAT/exFAT removable drives have **no ACLs at all**. Repeat per drive,
per sandbox user.

**Fixed NTFS drives** — explicit Deny for this user:
```powershell
icacls D:\ /deny "${sbxUser}:(OI)(CI)(F)"
# icacls E:\ /deny "${sbxUser}:(OI)(CI)(F)"   etc.
```
Deny beats Allow, so the sandbox user is blocked while your `$me` access is
untouched. Caveat: a subfolder with an *explicit* (non-inherited) Allow for
Users/Everyone can still be reachable — rare, not a hard guarantee.

**Removable / external drives (FAT/exFAT can't be ACL'd)** — Group Policy:
`gpedit.msc` → *User Configuration → Administrative Templates → System →
Removable Storage Access* → **"All Removable Storage classes: Deny all access" =
Enabled**, applied to the `$sbxUser` account (per-user local GPO). Low-tech
alternative: don't have external drives plugged in during a sandbox session.

Network drives are per-user mappings; a fresh sandbox profile has none — no action.

---

## Step 5 — Per project: kill push capability *(as `$sbxUser`)*

Log into the `$sbxUser` desktop (Start → avatar → **Switch user**), then:

```bash
cd "/c/ClaudeSandbox/AI-Playground"    # = $dest, in Git-Bash path form
# Fresh account already has NO stored git creds and NO ~/.ssh keys — the real block.
# Belt-and-suspenders: point pushes at a dead URL.
git remote set-url --push origin DISABLED://no-push
```

Three independent reasons `git push` fails: no credential-manager entry, no SSH
key, dead push URL.

- **Public remote:** fetch/pull work unauthenticated.
- **Private remote:** add a **read-only** personal access token for fetch/pull
  only — never a token with write scope.

---

## Step 6 — Per project: Claude Code fail-fast backstop

Repo-level deny so `git push` is refused before it runs (travels with the repo):

`.claude/settings.json`
```json
{ "permissions": { "deny": ["Bash(git push:*)"] } }
```

---

## Step 7 — Per project: install + run as `$sbxUser`

Install once under the sandbox account (persists between sessions):

- [ ] Node.js + Claude Code
- [ ] Project toolchain (uv, Python, etc.) as needed
- [ ] NVIDIA driver lives at host level — CUDA works natively

**Daily launch — pick one:**

| Method | Leave your desktop? | Notes |
|--------|--------------------|-------|
| **Run as different user** — `runas /user:<sbxUser>` a terminal, start Claude in it | No | Everything it spawns runs confined, renders on your desktop. Recommended. |
| **Fast User Switching** — Switch User to the sandbox account | Yes | Cleanest isolation; you context-switch desktops. |

> ⚠️ Starting Claude from a plain `TNG` terminal gives **none** of the isolation,
> silently. Always launch from the project's sandbox terminal. With multiple
> projects, also make sure you launch as the *right* project's user.

---

## Verify it worked *(as `$sbxUser`, for the project)*

```bash
cat "/c/Users/TNG/.ssh/id_rsa"              # must FAIL: Permission denied  → goal 1
ls "/c/ClaudeSandbox"                        # must FAIL / show nothing      → goal 1b
git push origin HEAD                         # must FAIL                      → goal 2
whoami /groups | grep -i admin               # NO admin membership           → goal 3
```

---

## Residual gaps (accepted trade-offs of the host-based approach)

- Sandbox users can still read system dirs (`C:\Program Files`, `C:\Windows`).
- A malicious download runs on your real OS as an unprivileged user — contained,
  not eliminated.
- Isolation depends on launching from the correct project's sandbox terminal.

If these become unacceptable, revisit a persistent Hyper-V VM with GPU-P for
airtight isolation at the cost of setup effort.

---

## Rollback (per project)

```powershell
# RUN AS ADMINISTRATOR. Set CONFIG for the project you're removing first.
Move-Item $dest $src
icacls $src /reset /T /C /Q
Remove-LocalUser -Name $sbxUser
# Optionally delete the sandbox user's profile under C:\Users\, revert push URL:
#   git remote set-url --push origin <original-url>
```

To tear down everything, roll back each project, then `Remove-Item $sandboxRoot`.

---

## Checklist

**One-time**
- [ ] `whoami` confirmed; `$me` set in CONFIG
- [ ] Step 1 shared root created

**Per project** (repeat for each)
- [ ] CONFIG block set: `$proj`, `$src`, `$sbxUser`
- [ ] Remote private/public determined
- [ ] Step 3 (user + relocate + ACLs)
- [ ] Step 4 (deny `D:`/other drives + removable-storage policy) — if applicable
- [ ] IntelliJ reopened at new path
- [ ] Step 5 push block applied
- [ ] Step 6 `.claude/settings.json` deny added
- [ ] Step 7 tooling installed under the sandbox user
- [ ] Verification commands all behave as expected
