use crate::process_authority::linux::{
    FileAccess, FileSelector, LinuxProcessPolicy, CONTROL_SOCKET, MAX_REQUEST_BYTES,
};
use std::ffi::CString;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Debug)]
pub(crate) struct LinuxLease {
    _owner: UnixStream,
    token: String,
    profile: CString,
    no_new_privs: bool,
    directories: Vec<PreparedDirectory>,
}

#[derive(Debug)]
struct PreparedDirectory {
    components: Vec<CString>,
    mode: libc::mode_t,
}

impl LinuxLease {
    pub(crate) fn prepare(policy: &LinuxProcessPolicy) -> Result<Self, String> {
        let mut directories = Vec::new();
        for rule in &policy.files {
            let mode = match rule.access {
                FileAccess::CreateDirectory => 0o777,
                FileAccess::CreatePrivateDirectory => 0o700,
                _ => continue,
            };
            let FileSelector::Exact {
                path,
                directory: true,
            } = &rule.selector
            else {
                return Err("directory preparation requires an exact directory".into());
            };
            if !path.is_absolute() {
                return Err("directory preparation requires an absolute path".into());
            }
            let mut components = Vec::new();
            for component in path.components() {
                match component {
                    std::path::Component::RootDir => (),
                    std::path::Component::Normal(name) => {
                        components.push(
                            CString::new(name.as_bytes()).map_err(|error| error.to_string())?,
                        );
                    }
                    _ => return Err("directory preparation requires a normal path".into()),
                }
            }
            directories.push(PreparedDirectory { components, mode });
        }
        let unavailable = |error| {
            format!(
            "Linux process authority is unavailable: {error}; install and start the process-authority service described in docs/linux.md"
        )
        };
        let metadata = std::fs::symlink_metadata(CONTROL_SOCKET)
            .map_err(|error| unavailable(error.to_string()))?;
        use std::os::unix::fs::FileTypeExt;
        if metadata.uid() != 0 || !metadata.file_type().is_socket() {
            return Err(unavailable(
                "control socket is not a root-owned Unix socket".into(),
            ));
        }
        let mut owner =
            UnixStream::connect(CONTROL_SOCKET).map_err(|error| unavailable(error.to_string()))?;
        let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
        let mut length = std::mem::size_of_val(&credentials) as libc::socklen_t;
        if unsafe {
            libc::getsockopt(
                owner.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                std::ptr::from_mut(&mut credentials).cast(),
                &mut length,
            )
        } != 0
            || length as usize != std::mem::size_of_val(&credentials)
            || credentials.uid != 0
        {
            return Err(unavailable(
                "control connection is not served by root".into(),
            ));
        }
        let payload = serde_json::to_vec(policy).map_err(|error| error.to_string())?;
        if payload.len() as u64 > MAX_REQUEST_BYTES {
            return Err("Linux process policy exceeds its transport limit".into());
        }
        owner
            .write_all(b"PREPARE ")
            .and_then(|_| owner.write_all(&payload))
            .and_then(|_| owner.write_all(b"\n"))
            .map_err(|error| unavailable(error.to_string()))?;
        let mut reader = BufReader::new(owner);
        let mut response = String::new();
        reader
            .by_ref()
            .take(4097)
            .read_line(&mut response)
            .map_err(|error| unavailable(error.to_string()))?;
        if response.len() > 4096 || !response.ends_with('\n') {
            return Err(unavailable("malformed preparation response".into()));
        }
        let Some(name) = response
            .strip_prefix("OK ")
            .and_then(|line| line.strip_suffix('\n'))
        else {
            return Err(unavailable(response.trim().to_string()));
        };
        let uid = unsafe { libc::getuid() };
        let prefix = format!("octopus-{uid}-");
        let token = name
            .strip_prefix(&prefix)
            .ok_or_else(|| unavailable("foreign profile identity".into()))?;
        if token.len() != 64
            || !token
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(unavailable("invalid profile identity".into()));
        }
        Ok(Self {
            _owner: reader.into_inner(),
            token: token.to_string(),
            profile: CString::new(format!("changeprofile {name}"))
                .map_err(|error| error.to_string())?,
            no_new_privs: !policy.allow_sandbox_delegation,
            directories,
        })
    }

    pub(crate) fn configure(
        self: &Arc<Self>,
        command: &mut Command,
        diagnostics: Option<Arc<SpawnDiagnostics>>,
        working_directory: Option<CString>,
    ) {
        let lease = Arc::clone(self);
        let request = format!("ATTACH {}\n", self.token).into_bytes();
        let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        address.sun_family = libc::AF_UNIX as libc::sa_family_t;
        for (target, source) in address.sun_path.iter_mut().zip(CONTROL_SOCKET.bytes()) {
            *target = source as libc::c_char;
        }
        let address_length = (std::mem::offset_of!(libc::sockaddr_un, sun_path)
            + CONTROL_SOCKET.len()
            + 1) as libc::socklen_t;
        unsafe {
            command.pre_exec(move || {
                let diagnostics = diagnostics.as_deref();
                attach_child(&address, address_length, &request, diagnostics)?;
                report_stage(diagnostics, b'U', change_profile(b"changeprofile unconfined"))?;
                for directory in &lease.directories {
                    report_stage(diagnostics, b'D', prepare_directory(directory))?;
                }
                report_stage(diagnostics, b'P', change_profile(lease.profile.as_bytes()))?;
                if lease.no_new_privs && libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                    return report_stage(diagnostics, b'N', Err(std::io::Error::last_os_error()));
                }
                if let Some(directory) = &working_directory {
                    enter_working_directory(directory, diagnostics)?;
                }
                write_stage(diagnostics, b'X');
                Ok(())
            });
        }
    }
}

pub(crate) struct SpawnDiagnostics(std::ptr::NonNull<AtomicU8>);

// The mapping is shared across fork and its only contents are accessed atomically.
unsafe impl Send for SpawnDiagnostics {}
unsafe impl Sync for SpawnDiagnostics {}

impl SpawnDiagnostics {
    pub(crate) fn new() -> std::io::Result<Self> {
        let length = std::mem::size_of::<AtomicU8>();
        let mapped = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                length,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED | libc::MAP_ANONYMOUS,
                -1,
                0,
            )
        };
        if mapped == libc::MAP_FAILED {
            return Err(std::io::Error::last_os_error());
        }
        let Some(stage) = std::ptr::NonNull::new(mapped.cast::<AtomicU8>()) else {
            unsafe { libc::munmap(mapped, length) };
            return Err(std::io::Error::other("spawn diagnostics mapping has a null address"));
        };
        unsafe { stage.as_ptr().write(AtomicU8::new(0)) };
        Ok(Self(stage))
    }
}

impl Drop for SpawnDiagnostics {
    fn drop(&mut self) {
        unsafe { libc::munmap(self.0.as_ptr().cast(), std::mem::size_of::<AtomicU8>()) };
    }
}

pub(crate) fn describe_spawn_error(diagnostics: &SpawnDiagnostics, error: std::io::Error) -> String {
    let stage = match unsafe { diagnostics.0.as_ref() }.load(Ordering::Relaxed) {
        b'C' => "connecting the child to Linux process authority",
        b'A' => "attaching the child to Linux process authority",
        b'U' => "switching to the directory preparation profile",
        b'D' => "preparing an authorized directory",
        b'P' => "applying the prepared AppArmor profile",
        b'N' => "setting no_new_privs",
        b'W' => "entering the tool working directory under Linux authority",
        b'X' => "launching the program after Linux authority setup",
        _ => "starting the child before Linux authority setup",
    };
    format!("{error} (while {stage})")
}

fn report_stage(
    diagnostic: Option<&SpawnDiagnostics>, stage: u8, result: std::io::Result<()>,
) -> std::io::Result<()> {
    if result.is_err() {
        write_stage(diagnostic, stage);
    }
    result
}

fn enter_working_directory(
    directory: &std::ffi::CStr,
    diagnostics: Option<&SpawnDiagnostics>,
) -> std::io::Result<()> {
    if unsafe { libc::chdir(directory.as_ptr()) } != 0 {
        return report_stage(diagnostics, b'W', Err(std::io::Error::last_os_error()));
    }
    Ok(())
}

fn write_stage(diagnostic: Option<&SpawnDiagnostics>, stage: u8) {
    if let Some(diagnostic) = diagnostic {
        unsafe { diagnostic.0.as_ref() }.store(stage, Ordering::Relaxed);
    }
}

fn attach_child(
    address: &libc::sockaddr_un,
    address_length: libc::socklen_t,
    request: &[u8],
    diagnostics: Option<&SpawnDiagnostics>,
) -> std::io::Result<()> {
    unsafe {
        let socket = libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0);
        if socket < 0 {
            return report_stage(diagnostics, b'C', Err(std::io::Error::last_os_error()));
        }
        if libc::connect(socket, std::ptr::from_ref(address).cast(), address_length) < 0 {
            let error = std::io::Error::last_os_error();
            libc::close(socket);
            return report_stage(diagnostics, b'C', Err(error));
        }
        let mut response = [0];
        let received = write_all(socket, request, true)
            .and_then(|_| read_one(socket, &mut response));
        libc::close(socket);
        report_stage(diagnostics, b'A', received)?;
        if response[0] != 0 {
            return report_stage(diagnostics, b'A', Err(std::io::Error::from_raw_os_error(libc::EACCES)));
        }
        Ok(())
    }
}

unsafe fn change_profile(value: &[u8]) -> std::io::Result<()> {
    let attribute = unsafe {
        libc::open(
            c"/proc/self/attr/current".as_ptr(),
            libc::O_WRONLY | libc::O_CLOEXEC,
        )
    };
    if attribute < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let result = unsafe { write_all(attribute, value, false) };
    unsafe { libc::close(attribute) };
    result
}

unsafe fn prepare_directory(directory: &PreparedDirectory) -> std::io::Result<()> {
    let mut parent = unsafe {
        libc::open(
            c"/".as_ptr(),
            libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if parent < 0 {
        return Err(std::io::Error::last_os_error());
    }
    for (index, component) in directory.components.iter().enumerate() {
        let flags = libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        let mut child = unsafe { libc::openat(parent, component.as_ptr(), flags) };
        if child < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
            let mode = if index + 1 == directory.components.len() {
                directory.mode
            } else {
                0o777
            };
            if unsafe { libc::mkdirat(parent, component.as_ptr(), mode) } < 0
                && std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST)
            {
                let error = std::io::Error::last_os_error();
                unsafe { libc::close(parent) };
                return Err(error);
            }
            child = unsafe { libc::openat(parent, component.as_ptr(), flags) };
        }
        if child < 0 {
            let error = std::io::Error::last_os_error();
            unsafe { libc::close(parent) };
            return Err(error);
        }
        unsafe { libc::close(parent) };
        parent = child;
    }
    unsafe { libc::close(parent) };
    Ok(())
}

unsafe fn write_all(fd: libc::c_int, mut bytes: &[u8], socket: bool) -> std::io::Result<()> {
    while !bytes.is_empty() {
        let count = if socket {
            unsafe { libc::send(fd, bytes.as_ptr().cast(), bytes.len(), libc::MSG_NOSIGNAL) }
        } else {
            unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) }
        };
        if count < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return Err(error);
        }
        if count == 0 {
            return Err(std::io::Error::from_raw_os_error(libc::EPIPE));
        }
        bytes = &bytes[count as usize..];
    }
    Ok(())
}

unsafe fn read_one(fd: libc::c_int, byte: &mut [u8; 1]) -> std::io::Result<()> {
    loop {
        match unsafe { libc::read(fd, byte.as_mut_ptr().cast(), 1) } {
            1 => return Ok(()),
            0 => return Err(std::io::Error::from_raw_os_error(libc::EPIPE)),
            _ => {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::EINTR) {
                    return Err(error);
                }
            }
        }
    }
}

pub(crate) fn configure_process_memory_allocator() {
    #[cfg(target_env = "gnu")]
    unsafe {
        // Cap glibc per-thread malloc arenas so bursts on Tokio worker threads
        // do not retain dozens of fragmented 64 MiB arenas on constrained hosts.
        let _ = libc::mallopt(libc::M_ARENA_MAX, 2);
    }
}

pub(crate) fn trim_process_memory() {
    #[cfg(target_env = "gnu")]
    unsafe {
        let _ = libc::malloc_trim(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_diagnostics_distinguish_setup_failure_from_exec_failure() {
        let missing = tempfile::tempdir().unwrap().path().join("missing-executable");
        for (stage, errno, label) in [
            (0, libc::ENOENT, "starting the child before Linux authority setup"),
            (b'P', libc::EACCES, "applying the prepared AppArmor profile"),
            (b'W', libc::ENOENT, "entering the tool working directory under Linux authority"),
            (b'X', libc::ENOENT, "launching the program after Linux authority setup"),
        ] {
            let diagnostics = Arc::new(SpawnDiagnostics::new().unwrap());
            let writer = Arc::clone(&diagnostics);
            let mut command = Command::new(&missing);
            if stage == 0 {
                command.current_dir(&missing);
            }
            let directory = CString::new(missing.as_os_str().as_bytes()).unwrap();
            unsafe {
                command.pre_exec(move || {
                    if stage == b'X' {
                        write_stage(Some(&writer), stage);
                        Ok(())
                    } else if stage == b'W' {
                        enter_working_directory(&directory, Some(&writer))
                    } else {
                        report_stage(Some(&writer), stage, Err(std::io::Error::from_raw_os_error(errno)))
                    }
                });
            }
            let error = command.spawn().unwrap_err();
            assert_eq!(error.raw_os_error(), Some(errno));
            assert!(describe_spawn_error(&diagnostics, error).contains(label));
        }

        let directory = tempfile::tempdir().unwrap();
        let expected = directory.path().canonicalize().unwrap();
        let working_directory = CString::new(expected.as_os_str().as_bytes()).unwrap();
        let mut command = Command::new("/bin/pwd");
        unsafe {
            command.pre_exec(move || enter_working_directory(&working_directory, None));
        }
        let output = command.output().unwrap();
        assert!(output.status.success());
        assert_eq!(std::str::from_utf8(&output.stdout).unwrap().trim(), expected.to_str().unwrap());
    }
}
