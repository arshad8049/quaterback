//! qb-scan — Quarterback's trusted tree scanner (agent-sandbox.md §6, §9.2).
//!
//! Reads a directory tree that may be hostile and writes a `git fast-import`
//! stream for exactly what it approved, plus a JSON report. Never follows a
//! symlink, never opens a special file for I/O, never reopens by path:
//!
//!   - every open is `openat2(root, rel, …, RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS
//!     | RESOLVE_NO_XDEV)`, so no component of `rel` may be a symlink or leave
//!     the root's filesystem;
//!   - an entry is first opened `O_PATH | O_NOFOLLOW` to classify it (fstat);
//!   - a symlink's target is read from that O_PATH fd (`readlinkat(fd, "")`);
//!   - a regular file is reopened `O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY`
//!     and must have the same (dev, ino) and still be a regular file, so a
//!     swap can never turn the read into a FIFO, device or tty read;
//!   - size, mtime and ctime are compared before and after reading, to catch an
//!     in-place rewrite of the same inode (the report lists such paths).
//!
//! Usage:
//!   qb-scan --root DIR --ref REFNAME --report FILE [--list FILE] [--exclude NAME]...
//!           [--max-files N] [--max-bytes N] [--max-file-bytes N] [--max-path N] [--max-depth N]
//!
//!   --list FILE   NUL-separated relative paths to include (seed mode: the
//!                 output of `git ls-files -z`); without it the whole tree is walked.
//!   --exclude N   top-level entry names to skip (e.g. .git, node_modules).
//!
//! Output: fast-import stream on stdout (one commit on REFNAME with `deleteall`,
//! so the tree is exactly the approved entries). Exit 0 when the scan ran
//! (verdict in the report), 2 on usage or I/O errors.

use std::ffi::CString;
use std::io::{self, Write};

const RESOLVE_NO_XDEV: u64 = 0x01;
const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
const RESOLVE_NO_SYMLINKS: u64 = 0x04;
const RESOLVE_BENEATH: u64 = 0x08;
const RESOLVE: u64 = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV;

#[repr(C)]
struct OpenHow { flags: u64, mode: u64, resolve: u64 }

// ---------------------------------------------------------------- syscalls (isolated)
mod sys {
    use super::*;

    pub fn openat2(dirfd: i32, rel: &[u8], flags: i32) -> io::Result<i32> {
        let path = CString::new(if rel.is_empty() { &b"."[..] } else { rel }).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?;
        let how = OpenHow { flags: (flags | libc::O_CLOEXEC) as u64, mode: 0, resolve: RESOLVE };
        let fd = unsafe {
            libc::syscall(libc::SYS_openat2, dirfd, path.as_ptr(), &how as *const OpenHow, std::mem::size_of::<OpenHow>())
        };
        if fd < 0 { Err(io::Error::last_os_error()) } else { Ok(fd as i32) }
    }

    pub fn open_root(path: &str) -> io::Result<i32> {
        let p = CString::new(path).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?;
        let fd = unsafe { libc::open(p.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 { Err(io::Error::last_os_error()) } else { Ok(fd) }
    }

    pub fn fstat(fd: i32) -> io::Result<libc::stat> {
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(fd, &mut st) } < 0 { Err(io::Error::last_os_error()) } else { Ok(st) }
    }

    pub fn readlink_fd(fd: i32) -> io::Result<Vec<u8>> {
        let mut buf = vec![0u8; 4096];
        let empty = CString::new("").unwrap();
        let n = unsafe { libc::readlinkat(fd, empty.as_ptr(), buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
        if n < 0 { return Err(io::Error::last_os_error()); }
        buf.truncate(n as usize);
        Ok(buf)
    }

    pub fn read_all(fd: i32, limit: u64) -> io::Result<Vec<u8>> {
        let mut out = Vec::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
            if n < 0 {
                let e = io::Error::last_os_error();
                if e.raw_os_error() == Some(libc::EINTR) { continue; }
                return Err(e);
            }
            if n == 0 { return Ok(out); }
            out.extend_from_slice(&buf[..n as usize]);
            if out.len() as u64 > limit { return Err(io::Error::from_raw_os_error(libc::EFBIG)); }
        }
    }

    pub fn list_dir(fd: i32) -> io::Result<Vec<Vec<u8>>> {
        let dup = unsafe { libc::dup(fd) };
        if dup < 0 { return Err(io::Error::last_os_error()); }
        let dir = unsafe { libc::fdopendir(dup) };
        if dir.is_null() { unsafe { libc::close(dup) }; return Err(io::Error::last_os_error()); }
        let mut names = Vec::new();
        loop {
            let ent = unsafe { libc::readdir(dir) };
            if ent.is_null() { break; }
            let name = unsafe { std::ffi::CStr::from_ptr((*ent).d_name.as_ptr()) }.to_bytes().to_vec();
            if name != b"." && name != b".." { names.push(name); }
        }
        unsafe { libc::closedir(dir) };
        names.sort();
        Ok(names)
    }

    pub fn close(fd: i32) { unsafe { libc::close(fd); } }
}

// ---------------------------------------------------------------- scanning
struct Limits { files: u64, bytes: u64, file_bytes: u64, path: usize, depth: usize }

#[derive(Default)]
struct Report {
    files: u64, bytes: u64, dirs: u64, symlinks: u64,
    limit_exceeded: Option<String>,
    rejected: Vec<(Vec<u8>, String)>,
    unsafe_symlinks: Vec<(Vec<u8>, Vec<u8>)>,
    hardlinks: Vec<Vec<u8>>,
    changed_during_read: Vec<Vec<u8>>,
    missing: Vec<Vec<u8>>,
}

struct Scanner<'a, W: Write> { root: i32, lim: Limits, rep: Report, out: &'a mut W, excludes: Vec<Vec<u8>> }

fn is_type(st: &libc::stat, t: libc::mode_t) -> bool { st.st_mode & libc::S_IFMT == t }

/// A symlink target is safe if it is relative and never climbs above the tree root.
fn symlink_escapes(link_rel: &[u8], target: &[u8]) -> bool {
    if target.first() == Some(&b'/') || target.is_empty() { return true; }
    let mut depth: i64 = link_rel.iter().filter(|&&c| c == b'/').count() as i64; // dirs containing the link
    for comp in target.split(|&c| c == b'/') {
        match comp {
            b"" | b"." => {}
            b".." => { depth -= 1; if depth < 0 { return true; } }
            _ => depth += 1,
        }
    }
    false
}

/// C-style quoted path for fast-import (handles newlines, quotes, bytes ≥ 0x80).
fn quote(p: &[u8]) -> Vec<u8> {
    let mut q = vec![b'"'];
    for &c in p {
        match c {
            b'"' => q.extend_from_slice(b"\\\""),
            b'\\' => q.extend_from_slice(b"\\\\"),
            b'\n' => q.extend_from_slice(b"\\n"),
            b'\t' => q.extend_from_slice(b"\\t"),
            0x20..=0x7e => q.push(c),
            _ => q.extend_from_slice(format!("\\{:03o}", c).as_bytes()),
        }
    }
    q.push(b'"');
    q
}

impl<'a, W: Write> Scanner<'a, W> {
    fn over(&mut self, what: &str) -> bool {
        if self.rep.limit_exceeded.is_none() { self.rep.limit_exceeded = Some(what.to_string()); }
        true
    }

    fn emit(&mut self, mode: &str, path: &[u8], data: &[u8]) -> io::Result<()> {
        self.out.write_all(format!("M {} inline ", mode).as_bytes())?;
        self.out.write_all(&quote(path))?;
        self.out.write_all(format!("\ndata {}\n", data.len()).as_bytes())?;
        self.out.write_all(data)?;
        self.out.write_all(b"\n")
    }

    /// Classify and emit one entry. Directories recurse when `recurse` is set.
    fn entry(&mut self, rel: &[u8], depth: usize, recurse: bool) -> io::Result<()> {
        if self.rep.limit_exceeded.is_some() { return Ok(()); }
        if rel.len() > self.lim.path { self.over("path_length"); return Ok(()); }
        if depth > self.lim.depth { self.over("depth"); return Ok(()); }
        let pfd = match sys::openat2(self.root, rel, libc::O_PATH | libc::O_NOFOLLOW) {
            Ok(fd) => fd,
            Err(e) if e.raw_os_error() == Some(libc::ENOENT) => { self.rep.missing.push(rel.to_vec()); return Ok(()); }
            Err(e) => { self.rep.rejected.push((rel.to_vec(), format!("open: {}", e))); return Ok(()); }
        };
        let st = sys::fstat(pfd)?;
        let res = if is_type(&st, libc::S_IFDIR) {
            sys::close(pfd);
            self.rep.dirs += 1;
            if recurse { self.dir(rel, depth) } else { Ok(()) }
        } else if is_type(&st, libc::S_IFLNK) {
            let target = sys::readlink_fd(pfd);
            sys::close(pfd);
            let target = target?;
            self.rep.symlinks += 1;
            if symlink_escapes(rel, &target) { self.rep.unsafe_symlinks.push((rel.to_vec(), target.clone())); }
            self.emit("120000", rel, &target)
        } else if is_type(&st, libc::S_IFREG) {
            sys::close(pfd);
            self.file(rel, &st)
        } else {
            sys::close(pfd);
            let kind = if is_type(&st, libc::S_IFIFO) { "fifo" } else if is_type(&st, libc::S_IFSOCK) { "socket" } else { "device" };
            self.rep.rejected.push((rel.to_vec(), kind.to_string()));
            Ok(())
        };
        res
    }

    fn file(&mut self, rel: &[u8], classified: &libc::stat) -> io::Result<()> {
        self.rep.files += 1;
        if self.rep.files > self.lim.files { self.over("file_count"); return Ok(()); }
        if classified.st_size as u64 > self.lim.file_bytes { self.over("file_bytes"); return Ok(()); }
        if self.rep.bytes + classified.st_size as u64 > self.lim.bytes { self.over("total_bytes"); return Ok(()); }
        let fd = match sys::openat2(self.root, rel, libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_NOCTTY) {
            Ok(fd) => fd,
            Err(e) => { self.rep.rejected.push((rel.to_vec(), format!("reopen: {}", e))); return Ok(()); }
        };
        let before = sys::fstat(fd)?;
        if !is_type(&before, libc::S_IFREG) || before.st_dev != classified.st_dev || before.st_ino != classified.st_ino {
            sys::close(fd);
            self.rep.rejected.push((rel.to_vec(), "changed type or identity between classify and open".into()));
            return Ok(());
        }
        let data = sys::read_all(fd, self.lim.file_bytes);
        let after = sys::fstat(fd)?;
        sys::close(fd);
        let data = match data {
            Ok(d) => d,
            Err(e) if e.raw_os_error() == Some(libc::EFBIG) => { self.over("file_bytes"); return Ok(()); }
            Err(e) => return Err(e),
        };
        if before.st_size != after.st_size || before.st_mtime != after.st_mtime || before.st_mtime_nsec != after.st_mtime_nsec
            || before.st_ctime != after.st_ctime || before.st_ctime_nsec != after.st_ctime_nsec || data.len() as i64 != after.st_size {
            self.rep.changed_during_read.push(rel.to_vec());
        }
        if before.st_nlink > 1 { self.rep.hardlinks.push(rel.to_vec()); }
        self.rep.bytes += data.len() as u64;
        let mode = if before.st_mode & 0o111 != 0 { "100755" } else { "100644" };
        self.emit(mode, rel, &data)
    }

    fn dir(&mut self, rel: &[u8], depth: usize) -> io::Result<()> {
        let dfd = match sys::openat2(self.root, rel, libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW) {
            Ok(fd) => fd,
            Err(e) => { self.rep.rejected.push((rel.to_vec(), format!("opendir: {}", e))); return Ok(()); }
        };
        let names = sys::list_dir(dfd);
        sys::close(dfd);
        for name in names? {
            if rel.is_empty() && self.excludes.iter().any(|x| *x == name) { continue; }
            let child = if rel.is_empty() { name } else { [rel, b"/", &name].concat() };
            self.entry(&child, depth + 1, true)?;
            if self.rep.limit_exceeded.is_some() { break; }
        }
        Ok(())
    }
}

fn json_str(b: &[u8]) -> String {
    let s = String::from_utf8_lossy(b);
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""), '\\' => o.push_str("\\\\"), '\n' => o.push_str("\\n"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn report_json(r: &Report) -> String {
    let list = |v: &Vec<Vec<u8>>| format!("[{}]", v.iter().map(|p| json_str(p)).collect::<Vec<_>>().join(","));
    format!(
        "{{\"files\":{},\"bytes\":{},\"dirs\":{},\"symlinks\":{},\"limit_exceeded\":{},\"rejected\":[{}],\"unsafe_symlinks\":[{}],\"hardlinks\":{},\"changed_during_read\":{},\"missing\":{}}}\n",
        r.files, r.bytes, r.dirs, r.symlinks,
        r.limit_exceeded.as_ref().map(|s| json_str(s.as_bytes())).unwrap_or_else(|| "null".into()),
        r.rejected.iter().map(|(p, why)| format!("{{\"path\":{},\"reason\":{}}}", json_str(p), json_str(why.as_bytes()))).collect::<Vec<_>>().join(","),
        r.unsafe_symlinks.iter().map(|(p, t)| format!("{{\"path\":{},\"target\":{}}}", json_str(p), json_str(t))).collect::<Vec<_>>().join(","),
        list(&r.hardlinks), list(&r.changed_during_read), list(&r.missing),
    )
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let get = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let num = |k: &str, d: u64| get(k).map(|v| v.parse::<u64>().unwrap_or(d)).unwrap_or(d);
    let (root, refname, report) = match (get("--root"), get("--ref"), get("--report")) {
        (Some(a), Some(b), Some(c)) => (a, b, c),
        _ => { eprintln!("usage: qb-scan --root DIR --ref REF --report FILE [--list FILE] [--exclude NAME]... [limits]"); std::process::exit(2); }
    };
    let excludes: Vec<Vec<u8>> = args.windows(2).filter(|w| w[0] == "--exclude").map(|w| w[1].as_bytes().to_vec()).collect();
    let lim = Limits {
        files: num("--max-files", 200_000), bytes: num("--max-bytes", 1 << 30), file_bytes: num("--max-file-bytes", 64 << 20),
        path: num("--max-path", 4096) as usize, depth: num("--max-depth", 64) as usize,
    };
    let rootfd = match sys::open_root(&root) { Ok(fd) => fd, Err(e) => { eprintln!("qb-scan: open root: {}", e); std::process::exit(2); } };

    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());
    let header = format!("commit {}\ncommitter qb <qb@localhost> 0 +0000\ndata 0\ndeleteall\n", refname);
    let mut sc = Scanner { root: rootfd, lim, rep: Report::default(), out: &mut out, excludes };
    let run = (|| -> io::Result<()> {
        sc.out.write_all(header.as_bytes())?;
        if let Some(list) = get("--list") {
            let data = std::fs::read(&list)?;
            for rel in data.split(|&c| c == 0).filter(|p| !p.is_empty()) {
                let depth = rel.iter().filter(|&&c| c == b'/').count() + 1;
                sc.entry(rel, depth, false)?;
                if sc.rep.limit_exceeded.is_some() { break; }
            }
        } else {
            sc.dir(b"", 0)?;
        }
        sc.out.write_all(b"\n")?;
        sc.out.flush()
    })();
    let rep = report_json(&sc.rep);
    if let Err(e) = std::fs::write(&report, rep) { eprintln!("qb-scan: write report: {}", e); std::process::exit(2); }
    if let Err(e) = run { eprintln!("qb-scan: {}", e); std::process::exit(2); }
}
