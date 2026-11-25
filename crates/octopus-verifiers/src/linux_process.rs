use crate::process_authority::linux::{
    FileAccess, FileSelector, LinuxProcessPolicy, CONTROL_SOCKET, MAX_REQUEST_BYTES,
};
use std::ffi::CString;
use std::io::{BufRead, BufReader, PipeReader, PipeWriter, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::Command;
use std::sync::Arc;

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

    pub(crate) fn configure(self: &Arc<Self>, command: &mut Command, diagnostics: Option<PipeWriter>) {
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
                let diagnostics = diagnostics.as_ref();
                attach_child(&address, address_length, &request, diagnostics)?;
                report_stage(diagnostics, b'U', change_profile(b"changeprofile unconfined"))?;
                for directory in &lease.directories {
                    report_stage(diagnostics, b'D', prepare_directory(directory))?;
                }
                report_stage(diagnostics, b'P', change_profile(lease.profile.as_bytes()))?;
                if lease.no_new_privs && libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                    return report_stage(diagnostics, b'N', Err(std::io::Error::last_os_error()));
                }
                write_stage(diagnostics, b'X');
                Ok(())
            });
        }
    }
}

pub(crate) fn spawn_diagnostics() -> Option<(PipeReader, PipeWriter)> {
    let (reader, writer) = std::io::pipe().ok()?;
    if unsafe { libc::fcntl(reader.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) } < 0 {
        return None;
    }
    Some((reader, writer))
}

pub(crate) fn describe_spawn_error(mut reader: PipeReader, error: std::io::Error) -> String {
    let mut stage = [0];
    let stage = match reader.read(&mut stage) {
        Ok(1) => match stage[0] {
            b'C' => "connecting the child to Linux process authority",
            b'A' => "attaching the child to Linux process authority",
            b'U' => "switching to the directory preparation profile",
            b'D' => "preparing an authorized directory",
            b'P' => "applying the prepared AppArmor profile",
            b'N' => "setting no_new_privs",
            b'X' => "launching the program after Linux authority setup",
            _ => return error.to_string(),
        },
        _ => return error.to_string(),
    };
    format!("{error} (while {stage})")
}

fn report_stage(
    diagnostic: Option<&PipeWriter>, stage: u8, result: std::io::Result<()>,
) -> std::io::Result<()> {
    if result.is_err() {
        write_stage(diagnostic, stage);
    }
    result
}

fn write_stage(diagnostic: Option<&PipeWriter>, stage: u8) {
    if let Some(diagnostic) = diagnostic {
        unsafe { libc::write(diagnostic.as_raw_fd(), std::ptr::from_ref(&stage).cast(), 1) };
    }
}

fn attach_child(
    address: &libc::sockaddr_un,
    address_length: libc::socklen_t,
    request: &[u8],
    diagnostics: Option<&PipeWriter>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_diagnostics_distinguish_setup_failure_from_exec_failure() {
        let missing = tempfile::tempdir().unwrap().path().join("missing-executable");
        for (stage, errno, label) in [
            (b'P', libc::EACCES, "applying the prepared AppArmor profile"),
            (b'X', libc::ENOENT, "launching the program after Linux authority setup"),
        ] {
            let (reader, writer) = spawn_diagnostics().unwrap();
            let mut command = Command::new(&missing);
            unsafe {
                command.pre_exec(move || {
                    if stage == b'X' {
                        write_stage(Some(&writer), stage);
                        Ok(())
                    } else {
                        report_stage(Some(&writer), stage, Err(std::io::Error::from_raw_os_error(errno)))
                    }
                });
            }
            let error = command.spawn().unwrap_err();
            assert_eq!(error.raw_os_error(), Some(errno));
            assert!(describe_spawn_error(reader, error).contains(label));
        }
    }
}
