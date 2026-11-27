use super::*;
use serde::{Deserialize, Serialize};
use std::os::unix::ffi::OsStrExt;

pub const CONTROL_SOCKET: &str = "/run/octopus-process-authority/control.sock";
pub const PLATFORM_EXECUTABLE: &str = "/usr/libexec/octopus/octopus-linux-process-authority";
pub const MAX_REQUEST_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LinuxProcessPolicy {
    pub files: Vec<FileRule>,
    pub read_only: Vec<PathBuf>,
    pub allow_network: bool,
    pub allow_local_ipc: bool,
    pub allow_application_launch: bool,
    pub allow_sandbox_delegation: bool,
    pub allow_process_signals: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LinuxRoomPolicy {
    pub readable: Vec<PathBuf>,
    pub writable: Vec<PathBuf>,
    pub read_only: Vec<PathBuf>,
    pub allow_network: bool,
}

pub fn prepare_room(
    room: LinuxRoomPolicy,
    argv: &[OsString],
    cwd: &Path,
    search_path: Option<&OsStr>,
) -> Result<PreparedProcess, String> {
    let (program, args) = argv.split_first().ok_or("room command is empty")?;
    let program = program
        .to_str()
        .ok_or("room executable path must be UTF-8")?;
    let cwd = normalize_existing_directory(cwd)?;
    let mut roots = room
        .readable
        .into_iter()
        .chain(room.writable.iter().cloned())
        .map(normalize_declared_exact_path)
        .collect::<Result<BTreeSet<_>, _>>()?;
    if !roots
        .iter()
        .any(|root| cwd == *root || root.is_dir() && cwd.starts_with(root))
    {
        return Err("room working directory is outside its declared roots".into());
    }
    for path in ["/usr", "/bin", "/sbin", "/lib", "/lib64"] {
        match std::fs::canonicalize(path) {
            Ok(path) => {
                roots.insert(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(format!("room runtime path '{path}': {error}")),
        }
    }
    let executable = resolve_executable(program, &cwd, search_path)?;
    let mut closure = BTreeSet::new();
    let mut pending = BTreeSet::from([executable.clone()]);
    while let Some(path) = pending.pop_first() {
        if !roots
            .iter()
            .any(|root| &path == root || root.is_dir() && path.starts_with(root))
        {
            return Err(format!(
                "room executable '{}' is outside its declared roots",
                path.display()
            ));
        }
        if closure.insert(path.clone()) {
            if let Some(interpreter) = executable_interpreter(&path)? {
                pending.insert(interpreter);
            }
        }
    }
    let authority = ProcessAuthority::resolve(
        roots.clone(),
        room.writable,
        Vec::new(),
        Vec::new(),
        Vec::new(),
        closure,
        room.allow_network,
        false,
        false,
        false,
        false,
        octopus_descriptors::ProcessSandboxMode::Enforced,
    )?;
    let mut policy = project(&authority, &executable)?;
    policy.read_only = room
        .read_only
        .into_iter()
        .map(normalize_declared_exact_path)
        .collect::<Result<Vec<_>, _>>()?;
    for path in &policy.read_only {
        if let Some(parent) = path.parent() {
            if authority
                .writable
                .iter()
                .any(|root| parent.starts_with(root))
            {
                policy.files.push(FileRule {
                    selector: FileSelector::Exact {
                        path: parent.to_path_buf(),
                        directory: true,
                    },
                    access: FileAccess::CreateDirectory,
                });
            }
        }
    }
    policy.files.retain(|rule| {
        !matches!(
            rule.access,
            FileAccess::CreateDirectory | FileAccess::CreatePrivateDirectory
        ) || match &rule.selector {
            FileSelector::Exact { path, .. } => {
                !policy.read_only.iter().any(|root| path.starts_with(root))
            }
            _ => false,
        }
    });
    for root in roots {
        policy.add_path(root, FileAccess::Execute, false)?;
    }
    policy.deduplicate_files();
    prepared(policy, executable, args)
}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileRule {
    pub selector: FileSelector,
    pub access: FileAccess,
}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize, Deserialize)]
#[serde(tag = "scope", rename_all = "snake_case", deny_unknown_fields)]
pub enum FileSelector {
    Exact {
        path: PathBuf,
        directory: bool,
    },
    Tree {
        path: PathBuf,
    },
    Names {
        directory: PathBuf,
        #[serde(with = "os_string_wire")]
        prefix: OsString,
        #[serde(with = "os_string_wire")]
        suffix: OsString,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileAccess {
    Read,
    Write,
    Execute,
    Map,
    CreateDirectory,
    CreatePrivateDirectory,
}

mod os_string_wire {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use std::ffi::OsString;

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum WireOsString {
        Utf8(String),
        Raw(OsString),
    }

    pub fn serialize<S>(value: &OsString, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match value.to_str() {
            Some(text) => serializer.serialize_str(text),
            None => value.serialize(serializer),
        }
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<OsString, D::Error>
    where
        D: Deserializer<'de>,
    {
        match WireOsString::deserialize(deserializer)? {
            WireOsString::Utf8(text) => Ok(OsString::from(text)),
            WireOsString::Raw(raw) => Ok(raw),
        }
    }
}

pub(super) fn prepare(
    authority: &ProcessAuthority,
    executable: PathBuf,
    args: &[OsString],
    _cwd: &Path,
) -> Result<PreparedProcess, String> {
    let policy = project(authority, &executable)?;
    prepared(policy, executable, args)
}

fn project(authority: &ProcessAuthority, executable: &Path) -> Result<LinuxProcessPolicy, String> {
    let mut policy = LinuxProcessPolicy {
        files: Vec::new(),
        read_only: Vec::new(),
        allow_network: authority.allow_network,
        allow_local_ipc: authority.allow_local_ipc,
        allow_application_launch: authority.allow_application_launch,
        allow_sandbox_delegation: authority.allow_sandbox_delegation,
        allow_process_signals: authority.allow_process_signals,
    };
    for (paths, access, exact) in [
        (&authority.readable, FileAccess::Read, false),
        (&authority.writable, FileAccess::Write, false),
        (&authority.executable, FileAccess::Execute, false),
        (&authority.readable_exact, FileAccess::Read, true),
        (&authority.writable_exact, FileAccess::Write, true),
        (&authority.writable_raw_exact, FileAccess::Write, true),
        (&authority.executable_exact, FileAccess::Execute, true),
    ] {
        for path in paths {
            policy.add_path(path.clone(), access, exact)?;
        }
    }
    let mut pending = authority.executable.clone();
    pending.extend(authority.executable_exact.iter().cloned());
    pending.insert(executable.to_path_buf());
    for path in runtime_executables(pending)? {
        policy.add_path(path, FileAccess::Execute, true)?;
    }
    for path in ["/lib", "/lib64", "/usr/lib", "/usr/lib64"] {
        policy.add_system_path(path, FileAccess::Map)?;
    }
    for path in [
        "/usr/share/locale",
        "/usr/share/zoneinfo",
        "/etc/ld.so.cache",
        "/etc/localtime",
        "/etc/passwd",
        "/etc/group",
        "/etc/nsswitch.conf",
        "/etc/fish",
        "/usr/share/fish",
        "/etc/terminfo",
        "/usr/share/terminfo",
        "/dev/random",
        "/dev/urandom",
    ] {
        policy.add_system_path(path, FileAccess::Read)?;
    }
    for path in [
        "/dev/null",
        "/dev/zero",
        "/dev/tty",
        "/dev/ptmx",
        "/dev/pts",
    ] {
        policy.add_system_path(path, FileAccess::Write)?;
    }
    if authority.allow_network {
        for path in [
            "/etc/ssl/certs",
            "/etc/ssl/cert.pem",
            "/usr/share/ca-certificates",
            "/etc/hosts",
            "/etc/resolv.conf",
            "/etc/gai.conf",
            "/etc/services",
            "/etc/protocols",
        ] {
            policy.add_system_path(path, FileAccess::Read)?;
        }
    }
    let mut paths = authority.readable.clone();
    paths.extend(authority.writable.iter().cloned());
    paths.extend(authority.readable_exact.iter().cloned());
    paths.extend(authority.writable_exact.iter().cloned());
    for path in path_ancestors(&paths) {
        policy.add_path(path, FileAccess::Read, true)?;
    }
    let mut writable = authority.writable.clone();
    writable.extend(authority.writable_exact.iter().cloned());
    for path in path_ancestors(&writable) {
        policy.files.push(FileRule {
            selector: FileSelector::Exact {
                path,
                directory: true,
            },
            access: FileAccess::CreateDirectory,
        });
    }
    let mut publication_targets = authority.writable_exact.clone();
    publication_targets.extend(
        authority
            .writable
            .iter()
            .filter(|path| path.is_file())
            .cloned(),
    );
    for path in publication_targets {
        policy.add_publication(&path)?;
    }
    if authority.allow_sandbox_delegation {
        for path in &paths {
            for ancestor in octopus_file_storage::publication::publication_ancestor_directories(
                path,
            )
            .map_err(|error| {
                format!(
                    "publication ancestry for '{}' is unavailable: {error}",
                    path.display()
                )
            })? {
                policy.files.push(FileRule {
                    selector: FileSelector::Exact {
                        path: ancestor,
                        directory: true,
                    },
                    access: FileAccess::Read,
                });
            }
        }
    }
    policy.deduplicate_files();
    Ok(policy)
}

fn prepared(
    policy: LinuxProcessPolicy,
    executable: PathBuf,
    args: &[OsString],
) -> Result<PreparedProcess, String> {
    let lease = crate::linux_process::LinuxLease::prepare(&policy)?;
    Ok(PreparedProcess {
        program: executable.clone(),
        args: args.to_vec(),
        executable,
        environment: BTreeMap::new(),
        sandbox_profile: None,
        linux_lease: Some(std::sync::Arc::new(lease)),
    })
}

impl LinuxProcessPolicy {
    fn deduplicate_files(&mut self) {
        let mut seen = std::collections::HashSet::with_capacity(self.files.len());
        self.files.retain(|rule| seen.insert(rule.clone()));
    }
    fn add_path(&mut self, path: PathBuf, access: FileAccess, exact: bool) -> Result<(), String> {
        let directory = match std::fs::metadata(&path) {
            Ok(metadata) => metadata.is_dir(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => !exact,
            Err(error) => {
                return Err(format!(
                    "Linux authority cannot inspect '{}': {error}",
                    path.display()
                ))
            }
        };
        let selector = if exact || !directory {
            FileSelector::Exact { path, directory }
        } else {
            FileSelector::Tree { path }
        };
        self.files.push(FileRule { selector, access });
        Ok(())
    }

    fn add_system_path(&mut self, path: &str, access: FileAccess) -> Result<(), String> {
        match std::fs::canonicalize(path) {
            Ok(path) => self.add_path(path, access, false),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!(
                "Linux runtime resource '{path}' cannot be resolved: {error}"
            )),
        }
    }

    fn add_publication(&mut self, path: &Path) -> Result<(), String> {
        use octopus_file_storage::publication::PublicationFileSelector;
        if path.is_dir() {
            return Ok(());
        }
        let projection =
            octopus_file_storage::publication::file_publication_access(path).map_err(|error| {
                format!(
                    "publication authority for '{}' failed: {error}",
                    path.display()
                )
            })?;
        for (paths, access) in [
            (projection.directory_reads, FileAccess::Read),
            (
                projection.directory_creates,
                FileAccess::CreatePrivateDirectory,
            ),
        ] {
            for path in paths {
                self.files.push(FileRule {
                    selector: FileSelector::Exact {
                        path,
                        directory: true,
                    },
                    access,
                });
            }
        }
        for (selectors, access) in [
            (projection.file_reads, FileAccess::Read),
            (projection.file_writes, FileAccess::Write),
        ] {
            for selector in selectors {
                let selector = match selector {
                    PublicationFileSelector::Exact(path) => FileSelector::Exact {
                        path,
                        directory: false,
                    },
                    PublicationFileSelector::Names {
                        directory,
                        prefix,
                        suffix,
                    } => FileSelector::Names {
                        directory,
                        prefix,
                        suffix,
                    },
                };
                self.files.push(FileRule { selector, access });
            }
        }
        Ok(())
    }

    pub fn apparmor_profile(
        &self,
        name: &str,
        uid: u32,
        unix_mediation: UnixSocketMediation,
    ) -> Result<String, String> {
        let prefix = format!("octopus-{uid}-");
        let suffix = name
            .strip_prefix(&prefix)
            .ok_or("AppArmor profile has a foreign owner")?;
        if suffix.len() != 64
            || !suffix
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("AppArmor profile has an invalid identity".into());
        }
        const PUBLICATION_DFA_COALESCE_THRESHOLD: usize = 12;
        let coalesce_publication = self
            .files
            .iter()
            .filter(|rule| matches!(rule.selector, FileSelector::Names { .. }))
            .count()
            > PUBLICATION_DFA_COALESCE_THRESHOLD;
        let mut coalesced_publication: BTreeMap<(PathBuf, FileAccess), BTreeSet<String>> =
            BTreeMap::new();
        let mut lines = BTreeSet::new();
        for rule in &self.files {
            let permissions = match rule.access {
                FileAccess::Read => "rk",
                FileAccess::Write => "rwkl",
                FileAccess::Execute => "rmix",
                FileAccess::Map => "mr",
                FileAccess::CreateDirectory | FileAccess::CreatePrivateDirectory => {
                    if !matches!(
                        &rule.selector,
                        FileSelector::Exact {
                            directory: true,
                            ..
                        }
                    ) {
                        return Err("directory preparation requires an exact directory".into());
                    }
                    "rk"
                }
            };
            if coalesce_publication && matches!(rule.access, FileAccess::Read | FileAccess::Write) {
                if let Some((directory, suffix)) = publication_coalesce_key(&rule.selector)? {
                    // Preserve full selector validation even when coalescing the compiled DFA pattern.
                    let _ = rule.selector.patterns()?;
                    coalesced_publication
                        .entry((directory, rule.access))
                        .or_default()
                        .insert(suffix);
                    continue;
                }
            }
            for pattern in rule.selector.patterns()? {
                lines.insert(format!("  \"{pattern}\" {permissions},\n"));
            }
        }
        for ((directory, access), suffixes) in coalesced_publication {
            let permissions = match access {
                FileAccess::Read => "rk",
                FileAccess::Write => "rwkl",
                _ => continue,
            };
            let directory = literal_path(&directory)?;
            let stem = directory.trim_end_matches('/');
            let pattern = if suffixes.len() == 1 {
                format!("{stem}/*{}", suffixes.iter().next().unwrap())
            } else {
                let joined = suffixes.into_iter().collect::<Vec<_>>().join(",");
                format!("{stem}/*{{{joined}}}")
            };
            lines.insert(format!("  \"{pattern}\" {permissions},\n"));
        }
        let mut profile = format!(
            "abi <abi/4.0>,\nprofile {name} flags=(mediate_deleted) {{\n  signal (receive),\n  signal (send) peer={name},\n  signal (send) peer={name}//&unconfined,\n  ptrace (read, trace) peer={name},\n  ptrace (read, trace) peer={name}//&unconfined,\n  ptrace (readby, tracedby),\n"
        );
        profile.push_str("  owner /proc/[0-9]*/{auxv,cmdline,environ,exe,fd/,fdinfo/,fdinfo/*,limits,maps,mountinfo,mounts,cgroup,stat,statm,status,task/,task/[0-9]*/{stat,status}} r,\n  /proc/{cpuinfo,meminfo,version,sys/kernel/hostname,sys/kernel/osrelease} r,\n  /sys/devices/system/cpu/ r,\n  /sys/devices/system/cpu/** r,\n  /sys/devices/system/node/ r,\n  /sys/devices/system/node/** r,\n  /sys/fs/cgroup/{cpu.max,cpu.cfs_quota_us,cpu.cfs_period_us,memory.max,memory.limit_in_bytes} r,\n  /sys/fs/cgroup/**/{cpu.max,cpu.cfs_quota_us,cpu.cfs_period_us,memory.max,memory.limit_in_bytes} r,\n");
        for line in lines {
            profile.push_str(&line);
        }
        for path in &self.read_only {
            for pattern in (FileSelector::Tree { path: path.clone() }).patterns()? {
                profile.push_str(&format!("  deny \"{pattern}\" wl,\n"));
            }
            for ancestor in path.ancestors().skip(1) {
                for pattern in (FileSelector::Exact {
                    path: ancestor.to_path_buf(),
                    directory: true,
                })
                .patterns()?
                {
                    profile.push_str(&format!("  deny \"{pattern}\" w,\n"));
                }
            }
        }
        if self.allow_network {
            profile.push_str("  network,\n");
        } else if self.allow_local_ipc || self.allow_application_launch {
            profile.push_str("  network unix,\n");
        }
        let allow_unix =
            self.allow_network || self.allow_local_ipc || self.allow_application_launch;
        match unix_mediation {
            UnixSocketMediation::FineGrained if allow_unix => profile.push_str("  unix,\n"),
            UnixSocketMediation::FineGrained => profile.push_str(ANONYMOUS_LOCAL_SOCKETS),
            UnixSocketMediation::FamilyAndType if !allow_unix => {
                profile.push_str("  network unix stream,\n  network unix seqpacket,\n");
            }
            UnixSocketMediation::FamilyAndType => {}
        }
        if self.allow_application_launch {
            profile.push_str("  dbus (send, receive),\n");
        }
        if self.allow_process_signals {
            profile.push_str("  signal (send),\n");
        }
        if self.allow_sandbox_delegation {
            profile.push_str(&format!("  change_profile -> octopus-{uid}-*,\n"));
            profile.push_str("  change_profile -> unconfined,\n  /proc/[0-9]*/attr/current w,\n");
            profile.push_str(&format!("  \"{PLATFORM_EXECUTABLE}\" rmix,\n"));
            profile.push_str(&format!("  \"{CONTROL_SOCKET}\" rw,\n"));
            if unix_mediation == UnixSocketMediation::FineGrained {
                profile.push_str("  unix (create, getattr, getopt, setopt),\n");
            }
        } else {
            profile.push_str(&format!("  deny \"{CONTROL_SOCKET}\" rw,\n"));
        }
        profile.push_str(
            "  deny /sys/kernel/security/** wkl,\n  deny /sys/fs/cgroup/** wkl,\n  deny /run/octopus-process-authority/ wkl,\n  deny /run/octopus-process-authority/leases/** rwkl,\n  deny /run/octopus-process-authority/service.lock rwkl,\n}\n"
        );
        Ok(profile)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnixSocketMediation {
    FineGrained,
    FamilyAndType,
}

/// A process without network or local IPC authority still owns unnamed stream
/// and seqpacket socket pairs, which event loops use as wake-up channels and
/// Rust's Unix process spawner uses to relay child spawn errors before exec.
/// AppArmor mediates a pathname socket through the file rule of its path, so
/// the control socket is granted or denied by path; a `unix` rule only accepts
/// abstract or unnamed addresses. Abstract sockets stay closed here.
const ANONYMOUS_LOCAL_SOCKETS: &str =
    "  unix (create, read, write, shutdown, getattr, getopt, setopt) type=stream addr=none,\n  unix (create, read, write, shutdown, getattr, getopt, setopt) type=seqpacket addr=none,\n";

impl FileSelector {
    fn patterns(&self) -> Result<Vec<String>, String> {
        match self {
            Self::Exact { path, directory } => {
                let mut path = literal_path(path)?;
                if *directory && path != "/" {
                    path.push('/');
                }
                Ok(vec![path])
            }
            Self::Tree { path } => {
                let path = literal_path(path)?;
                let stem = path.trim_end_matches('/');
                Ok(vec![path.clone(), format!("{stem}/"), format!("{stem}/**")])
            }
            Self::Names {
                directory,
                prefix,
                suffix,
            } => {
                if prefix.is_empty()
                    || suffix.is_empty()
                    || prefix.as_bytes().contains(&b'/')
                    || suffix.as_bytes().contains(&b'/')
                {
                    return Err("publication filename selector is not bounded".into());
                }
                let directory = literal_path(directory)?;
                Ok(vec![format!(
                    "{}/{}*{}",
                    directory.trim_end_matches('/'),
                    literal(prefix)?,
                    literal(suffix)?
                )])
            }
        }
    }
}

fn publication_coalesce_key(selector: &FileSelector) -> Result<Option<(PathBuf, String)>, String> {
    const COORDINATION_DIR: &str = ".octopus-publication";
    const COORDINATION_SUFFIXES: &[&str] = &[
        ".lock",
        ".pending",
        ".install",
        ".directory",
        ".reclaim",
        ".plan",
        ".bytes",
        ".preimage",
        ".receipt",
        ".tmp",
    ];
    match selector {
        FileSelector::Names {
            directory, suffix, ..
        } if directory.file_name() == Some(OsStr::new(COORDINATION_DIR)) => {
            let escaped = literal(suffix)?;
            if escaped.contains(',') {
                return Ok(None);
            }
            Ok(Some((directory.clone(), escaped)))
        }
        FileSelector::Exact {
            path,
            directory: false,
        } => {
            let Some(parent) = path.parent() else {
                return Ok(None);
            };
            if parent.file_name() != Some(OsStr::new(COORDINATION_DIR)) {
                return Ok(None);
            }
            let Some(name) = path.file_name().and_then(OsStr::to_str) else {
                return Ok(None);
            };
            for &ext in COORDINATION_SUFFIXES {
                if name.ends_with(ext) && name.len() > ext.len() {
                    return Ok(Some((parent.to_path_buf(), ext.to_string())));
                }
            }
            Ok(None)
        }
        _ => Ok(None),
    }
}

fn literal_path(path: &Path) -> Result<String, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
    {
        return Err("AppArmor path must be normal and absolute".into());
    }
    literal(path.as_os_str())
}

fn literal(value: &OsStr) -> Result<String, String> {
    let text = value
        .to_str()
        .ok_or("AppArmor policy paths must be UTF-8")?;
    let mut escaped = String::new();
    for character in text.chars() {
        if character.is_control() {
            return Err("AppArmor policy path contains a control character".into());
        }
        if "\\\"*?[]{}^".contains(character) {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    Ok(escaped)
}

fn read_prefix(file: &mut std::fs::File, buffer: &mut [u8]) -> std::io::Result<usize> {
    use std::io::Read;
    let mut filled = 0;
    while filled < buffer.len() {
        match file.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(filled)
}

fn read_u16_endian(bytes: &[u8], little_endian: bool) -> u16 {
    let array: [u8; 2] = [bytes[0], bytes[1]];
    if little_endian {
        u16::from_le_bytes(array)
    } else {
        u16::from_be_bytes(array)
    }
}

fn read_u32_endian(bytes: &[u8], little_endian: bool) -> u32 {
    let array: [u8; 4] = [bytes[0], bytes[1], bytes[2], bytes[3]];
    if little_endian {
        u32::from_le_bytes(array)
    } else {
        u32::from_be_bytes(array)
    }
}

fn read_u64_endian(bytes: &[u8], little_endian: bool) -> u64 {
    let array: [u8; 8] = [
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
    ];
    if little_endian {
        u64::from_le_bytes(array)
    } else {
        u64::from_be_bytes(array)
    }
}

fn elf_interpreter(file: &mut std::fs::File, header: &[u8], path: &Path) -> Result<Option<Vec<u8>>, String> {
    use std::io::{Read, Seek, SeekFrom};

    const ELFCLASS32: u8 = 1;
    const ELFCLASS64: u8 = 2;
    const ELFDATA2LSB: u8 = 1;
    const ELFDATA2MSB: u8 = 2;
    const PT_INTERP: u32 = 3;
    const PN_XNUM: usize = 0xffff;
    const MAX_PHDR_TABLE_BYTES: usize = 4 * 1024 * 1024;
    const MAX_INTERP_BYTES: usize = 4096;

    if header.len() < 16 {
        return Err(format!(
            "Linux executable '{}' is invalid: truncated ELF header",
            path.display()
        ));
    }
    let little_endian = match header[5] {
        ELFDATA2LSB => true,
        ELFDATA2MSB => false,
        other => {
            return Err(format!(
                "Linux executable '{}' is invalid: unsupported ELF endianness {other}",
                path.display()
            ));
        }
    };
    let (is_64, phoff, phentsize, mut phnum, min_phentsize, shoff, shentsize) = match header[4] {
        ELFCLASS32 => {
            if header.len() < 52 {
                return Err(format!(
                    "Linux executable '{}' is invalid: truncated ELF32 header",
                    path.display()
                ));
            }
            (
                false,
                u64::from(read_u32_endian(&header[28..32], little_endian)),
                usize::from(read_u16_endian(&header[42..44], little_endian)),
                usize::from(read_u16_endian(&header[44..46], little_endian)),
                32usize,
                u64::from(read_u32_endian(&header[32..36], little_endian)),
                usize::from(read_u16_endian(&header[46..48], little_endian)),
            )
        }
        ELFCLASS64 => {
            if header.len() < 64 {
                return Err(format!(
                    "Linux executable '{}' is invalid: truncated ELF64 header",
                    path.display()
                ));
            }
            (
                true,
                read_u64_endian(&header[32..40], little_endian),
                usize::from(read_u16_endian(&header[54..56], little_endian)),
                usize::from(read_u16_endian(&header[56..58], little_endian)),
                56usize,
                read_u64_endian(&header[40..48], little_endian),
                usize::from(read_u16_endian(&header[58..60], little_endian)),
            )
        }
        other => {
            return Err(format!(
                "Linux executable '{}' is invalid: unsupported ELF class {other}",
                path.display()
            ));
        }
    };

    if phnum == PN_XNUM && shoff != 0 {
        let min_shentsize = if is_64 { 64usize } else { 40usize };
        if shentsize < min_shentsize {
            return Err(format!(
                "Linux executable '{}' is invalid: invalid ELF section header entry size",
                path.display()
            ));
        }
        let mut sh0 = vec![0u8; min_shentsize];
        file.seek(SeekFrom::Start(shoff))
            .and_then(|_| file.read_exact(&mut sh0))
            .map_err(|error| {
                format!(
                    "Linux executable '{}' is invalid: cannot read ELF section header 0: {error}",
                    path.display()
                )
            })?;
        let sh_info = if is_64 {
            read_u32_endian(&sh0[44..48], little_endian)
        } else {
            read_u32_endian(&sh0[28..32], little_endian)
        };
        phnum = usize::try_from(sh_info).map_err(|_| {
            format!(
                "Linux executable '{}' is invalid: ELF program header count overflow",
                path.display()
            )
        })?;
    }

    if phnum == 0 {
        return Ok(None);
    }
    if phentsize < min_phentsize {
        return Err(format!(
            "Linux executable '{}' is invalid: program header entry size {phentsize} is too small",
            path.display()
        ));
    }
    let table_len = phentsize
        .checked_mul(phnum)
        .filter(|&len| len <= MAX_PHDR_TABLE_BYTES)
        .ok_or_else(|| {
            format!(
                "Linux executable '{}' is invalid: ELF program header table exceeds bounds",
                path.display()
            )
        })?;
    let mut phdrs = vec![0u8; table_len];
    file.seek(SeekFrom::Start(phoff))
        .and_then(|_| file.read_exact(&mut phdrs))
        .map_err(|error| {
            format!(
                "Linux executable '{}' is invalid: cannot read ELF program headers: {error}",
                path.display()
            )
        })?;

    let mut interp_segment: Option<(u64, usize)> = None;
    for entry in phdrs.chunks_exact(phentsize) {
        let p_type = read_u32_endian(&entry[0..4], little_endian);
        if p_type != PT_INTERP {
            continue;
        }
        if interp_segment.is_some() {
            return Err("Linux executable declares several interpreters".into());
        }
        let (p_offset, p_filesz) = if is_64 {
            (
                read_u64_endian(&entry[8..16], little_endian),
                read_u64_endian(&entry[32..40], little_endian),
            )
        } else {
            (
                u64::from(read_u32_endian(&entry[4..8], little_endian)),
                u64::from(read_u32_endian(&entry[16..20], little_endian)),
            )
        };
        let p_filesz = usize::try_from(p_filesz)
            .ok()
            .filter(|&size| size > 0 && size <= MAX_INTERP_BYTES)
            .ok_or_else(|| {
                "Linux executable interpreter is invalid: PT_INTERP size out of bounds".to_string()
            })?;
        interp_segment = Some((p_offset, p_filesz));
    }

    let Some((offset, size)) = interp_segment else {
        return Ok(None);
    };
    let mut raw = vec![0u8; size];
    file.seek(SeekFrom::Start(offset))
        .and_then(|_| file.read_exact(&mut raw))
        .map_err(|error| format!("Linux executable interpreter is invalid: {error}"))?;
    if let Some(nul) = raw.iter().position(|byte| *byte == 0) {
        raw.truncate(nul);
    }
    if raw.is_empty() {
        return Err("Linux executable interpreter is invalid: empty PT_INTERP".into());
    }
    Ok(Some(raw))
}

fn executable_interpreter(path: &Path) -> Result<Option<PathBuf>, String> {
    let mut file = std::fs::File::open(path).map_err(|error| {
        format!(
            "Linux executable '{}' cannot be read: {error}",
            path.display()
        )
    })?;
    let mut header = [0u8; 4096];
    let read_len = read_prefix(&mut file, &mut header).map_err(|error| {
        format!(
            "Linux executable '{}' cannot be read: {error}",
            path.display()
        )
    })?;
    let prefix = &header[..read_len];
    let interpreter = if prefix.starts_with(b"#!") {
        prefix[2..]
            .split(|byte| *byte == b'\n')
            .next()
            .unwrap_or_default()
            .split(|byte| byte.is_ascii_whitespace())
            .find(|part| !part.is_empty())
            .ok_or("Linux script has an empty interpreter")?
            .to_vec()
    } else if prefix.starts_with(b"\x7fELF") {
        let Some(interpreter) = elf_interpreter(&mut file, prefix, path)? else {
            return Ok(None);
        };
        interpreter
    } else {
        return Err(format!(
            "Linux executable '{}' is not ELF or a script",
            path.display()
        ));
    };
    let interpreter = PathBuf::from(OsStr::from_bytes(&interpreter));
    if !interpreter.is_absolute() {
        return Err("Linux executable interpreter is not absolute".into());
    }
    let interpreter = normalize_existing_path(interpreter)?;
    if !executable_file(&interpreter) {
        return Err("Linux executable interpreter is not executable".into());
    }
    Ok(Some(interpreter))
}

pub(super) fn runtime_executables(
    mut pending: BTreeSet<PathBuf>,
) -> Result<BTreeSet<PathBuf>, String> {
    let mut visited = BTreeSet::new();
    while let Some(path) = pending.pop_first() {
        if path.is_dir() || !visited.insert(path.clone()) {
            continue;
        }
        if let Some(interpreter) = executable_interpreter(&path)? {
            pending.insert(interpreter);
        }
    }
    Ok(visited)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(network: bool, local_ipc: bool, delegation: bool) -> String {
        profile_with_mediation(
            network,
            local_ipc,
            delegation,
            UnixSocketMediation::FineGrained,
        )
    }

    fn profile_with_mediation(
        network: bool,
        local_ipc: bool,
        delegation: bool,
        unix_mediation: UnixSocketMediation,
    ) -> String {
        LinuxProcessPolicy {
            files: vec![FileRule {
                selector: FileSelector::Tree {
                    path: PathBuf::from("/var/tmp/octopus-room"),
                },
                access: FileAccess::Write,
            }],
            read_only: Vec::new(),
            allow_network: network,
            allow_local_ipc: local_ipc,
            allow_application_launch: false,
            allow_sandbox_delegation: delegation,
            allow_process_signals: false,
        }
        .apparmor_profile(
            &format!("octopus-1000-{}", "0".repeat(64)),
            1000,
            unix_mediation,
        )
        .unwrap()
    }

    fn shapes() -> Vec<(bool, bool, bool)> {
        let mut shapes = Vec::new();
        for network in [false, true] {
            for local_ipc in [false, true] {
                for delegation in [false, true] {
                    shapes.push((network, local_ipc, delegation));
                }
            }
        }
        shapes
    }

    #[test]
    fn the_control_socket_is_granted_or_denied_by_its_path() {
        for (network, local_ipc, delegation) in shapes() {
            let profile = profile(network, local_ipc, delegation);
            assert!(!profile.contains("peer=(addr=\"/"), "{profile}");
            assert!(!profile.contains("deny unix"), "{profile}");
            assert!(!profile.contains("unix (connect"), "{profile}");
            let allowed = profile.contains(&format!("  \"{CONTROL_SOCKET}\" rw,\n"));
            let denied = profile.contains(&format!("  deny \"{CONTROL_SOCKET}\" rw,\n"));
            assert_eq!((allowed, denied), (delegation, !delegation), "{profile}");
        }
    }

    #[test]
    fn a_process_without_ipc_owns_only_unnamed_local_sockets() {
        for delegation in [false, true] {
            let closed = profile(false, false, delegation);
            assert!(closed.contains(ANONYMOUS_LOCAL_SOCKETS), "{closed}");
            assert!(!closed.contains("  unix,\n") && !closed.contains("network"), "{closed}");
            assert_eq!(
                closed.contains("  unix (create, getattr, getopt, setopt),\n"),
                delegation,
                "only delegation creates the socket it connects to the control path: {closed}"
            );
        }
        let local = profile(false, true, false);
        assert!(local.contains("  network unix,\n  unix,\n") && !local.contains(ANONYMOUS_LOCAL_SOCKETS), "{local}");
        let network = profile(true, false, false);
        assert!(network.contains("  network,\n  unix,\n") && !network.contains(ANONYMOUS_LOCAL_SOCKETS), "{network}");
    }

    #[test]
    fn cpu_topology_and_cgroup_limits_are_read_only() {
        let generated = profile(false, false, false);
        assert!(generated.contains("  /sys/devices/system/cpu/** r,\n"), "{generated}");
        assert!(generated.contains("  /sys/devices/system/node/** r,\n"), "{generated}");
        assert!(generated.contains("  /sys/fs/cgroup/**/{cpu.max,cpu.cfs_quota_us,cpu.cfs_period_us,memory.max,memory.limit_in_bytes} r,\n"), "{generated}");
        assert!(generated.contains("  deny /sys/fs/cgroup/** wkl,\n"), "{generated}");
    }

    #[test]
    fn compatibility_uses_network_rules_and_preserves_control_socket_path() {
        for (network, local_ipc, delegation) in shapes() {
            let profile = profile_with_mediation(
                network,
                local_ipc,
                delegation,
                UnixSocketMediation::FamilyAndType,
            );
            assert!(
                !profile
                    .lines()
                    .any(|line| line.trim_start().starts_with("unix ")
                        || line.trim_start() == "unix,"),
                "{profile}"
            );
            let rules: Vec<&str> = if network {
                vec!["  network,"]
            } else if local_ipc {
                vec!["  network unix,"]
            } else {
                vec!["  network unix stream,", "  network unix seqpacket,"]
            };
            assert_eq!(
                profile
                    .lines()
                    .filter(|line| line.starts_with("  network"))
                    .collect::<Vec<_>>(),
                rules,
            );
            let access = if delegation { "" } else { "deny " };
            assert!(profile.contains(&format!("  {access}\"{CONTROL_SOCKET}\" rw,\n")));
        }
    }

    #[test]
    fn the_installed_parser_accepts_every_profile_shape() {
        let Some(parser) = ["/usr/sbin/apparmor_parser", "/sbin/apparmor_parser"]
            .into_iter()
            .map(Path::new)
            .find(|path| path.is_file())
        else {
            return;
        };
        if !Path::new("/etc/apparmor.d/abi/4.0").is_file() {
            return;
        }
        let directory = std::env::temp_dir().join(format!("octopus-apparmor-shapes-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        for (index, (network, local_ipc, delegation)) in shapes().into_iter().enumerate() {
            let path = directory.join(format!("shape-{index}"));
            std::fs::write(&path, profile(network, local_ipc, delegation)).unwrap();
            let output = std::process::Command::new(parser)
                .args([
                    "--config-file=/dev/null",
                    "--skip-cache",
                    "--skip-kernel-load",
                    "--warn=all",
                    "--Werror",
                    "--jobs=1",
                ])
                .arg(&path)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "network={network} local_ipc={local_ipc} delegation={delegation}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn executable_interpreter_handles_elf_and_shebang_without_full_read() {
        let current = std::env::current_exe().unwrap();
        let current_interp = executable_interpreter(&current).unwrap();
        if let Some(interp) = current_interp {
            assert!(interp.is_absolute(), "{interp:?}");
            assert!(interp.is_file(), "{interp:?}");
        }

        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("run.sh");
        std::fs::write(&script, b"#! /bin/sh\necho ok\n").unwrap();
        let expected_sh = normalize_existing_path(PathBuf::from("/bin/sh")).unwrap();
        assert_eq!(executable_interpreter(&script).unwrap(), Some(expected_sh));

        let non_elf = dir.path().join("plain.txt");
        std::fs::write(&non_elf, b"not an executable\n").unwrap();
        assert!(executable_interpreter(&non_elf)
            .unwrap_err()
            .contains("is not ELF or a script"));

        let truncated_elf = dir.path().join("truncated.elf");
        std::fs::write(&truncated_elf, b"\x7fELF\x02\x01").unwrap();
        assert!(executable_interpreter(&truncated_elf)
            .unwrap_err()
            .contains("truncated ELF header"));
    }

    #[test]
    fn file_selector_names_uses_compact_utf8_strings_and_accepts_legacy_wire_format() {
        let hex_prefix = "a".repeat(64);
        let selector = FileSelector::Names {
            directory: PathBuf::from("/tmp/octopus-pub"),
            prefix: OsString::from(&hex_prefix),
            suffix: OsString::from(".tmp"),
        };
        let encoded = serde_json::to_string(&selector).unwrap();
        assert!(
            encoded.contains(&format!("\"prefix\":\"{hex_prefix}\"")),
            "expected compact UTF-8 prefix string, got: {encoded}"
        );
        assert!(
            encoded.contains("\"suffix\":\".tmp\""),
            "expected compact UTF-8 suffix string, got: {encoded}"
        );
        assert!(
            !encoded.contains("\"Unix\":["),
            "UTF-8 OsString must not serialize as byte integer array: {encoded}"
        );
        let decoded: FileSelector = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, selector);

        let legacy_json = r#"{"scope":"names","directory":"/tmp/octopus-pub","prefix":{"Unix":[97,98,99]},"suffix":{"Unix":[46,116,109,112]}}"#;
        let legacy_decoded: FileSelector = serde_json::from_str(legacy_json).unwrap();
        assert_eq!(
            legacy_decoded,
            FileSelector::Names {
                directory: PathBuf::from("/tmp/octopus-pub"),
                prefix: OsString::from("abc"),
                suffix: OsString::from(".tmp"),
            }
        );

        let raw_selector = FileSelector::Names {
            directory: PathBuf::from("/tmp/octopus-pub"),
            prefix: OsStr::from_bytes(b"bad-\xff-\xfe").to_os_string(),
            suffix: OsString::from(".tmp"),
        };
        let raw_encoded = serde_json::to_string(&raw_selector).unwrap();
        let raw_decoded: FileSelector = serde_json::from_str(&raw_encoded).unwrap();
        assert_eq!(raw_decoded, raw_selector);
    }

    #[test]
    fn project_deduplicates_files_and_keeps_81_file_batch_well_under_transport_limit() {
        assert_eq!(MAX_REQUEST_BYTES, 4 * 1024 * 1024);
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let mut writable_exact = BTreeSet::new();
        for index in 0..81 {
            let file = root
                .join("registry")
                .join("run_record")
                .join("run_operator_chat_batch_test")
                .join(format!("item_{index:02}"))
                .join("descriptor.json");
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            writable_exact.insert(file);
        }
        let executable = normalize_existing_path(PathBuf::from("/bin/sh")).unwrap();
        let authority = ProcessAuthority {
            sandbox_mode: octopus_descriptors::ProcessSandboxMode::Enforced,
            readable: BTreeSet::from([root.clone()]),
            writable: BTreeSet::new(),
            executable: BTreeSet::new(),
            readable_exact: BTreeSet::new(),
            writable_exact,
            writable_raw_exact: BTreeSet::new(),
            executable_exact: BTreeSet::from([executable.clone()]),
            executable_links: BTreeSet::new(),
            allow_network: false,
            allow_local_ipc: false,
            allow_application_launch: false,
            allow_sandbox_delegation: false,
            allow_process_signals: false,
        };
        let policy = project(&authority, &executable).unwrap();
        let unique: std::collections::HashSet<&FileRule> = policy.files.iter().collect();
        assert_eq!(
            unique.len(),
            policy.files.len(),
            "projected policy.files must be deduplicated"
        );
        assert!(
            policy
                .files
                .iter()
                .any(|rule| matches!(rule.selector, FileSelector::Names { .. })),
            "expected FileSelector::Names rules from file publication access"
        );
        let payload = serde_json::to_vec(&policy).unwrap();
        let payload_text = String::from_utf8(payload.clone()).unwrap();
        assert!(
            !payload_text.contains("\"Unix\":["),
            "serialized policy should not contain Unix byte-array OsStrings"
        );
        eprintln!(
            "P0-2 81-file batch policy: rules={}, payload_bytes={}",
            policy.files.len(),
            payload.len()
        );
        assert!(
            (payload.len() as u64) < 300 * 1024,
            "expected compact deduplicated 81-file policy well under 300 KiB, got {} bytes",
            payload.len()
        );
        let profile_text = policy
            .apparmor_profile(
                &format!("octopus-1000-{}", "c".repeat(64)),
                1000,
                UnixSocketMediation::FamilyAndType,
            )
            .unwrap();
        assert!(
            profile_text.contains(".octopus-publication/*{"),
            "expected coalesced .octopus-publication AppArmor rules for 81-file batch"
        );
        assert!(
            profile_text.len() < 40 * 1024,
            "expected compact coalesced AppArmor profile text, got {} bytes",
            profile_text.len()
        );
    }

    #[test]
    fn writable_raw_exact_grants_rwkl_without_publication_or_directory_create() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let db = root.join("ledger-index.sqlite");
        let wal = root.join("ledger-index.sqlite-wal");
        let shm = root.join("ledger-index.sqlite-shm");
        std::fs::write(&db, b"").unwrap();
        std::fs::write(&wal, b"").unwrap();
        std::fs::write(&shm, b"").unwrap();
        let executable = normalize_existing_path(PathBuf::from("/bin/sh")).unwrap();
        let authority = ProcessAuthority::resolve(
            Vec::<PathBuf>::new(),
            Vec::<PathBuf>::new(),
            Vec::<PathBuf>::new(),
            vec![db.clone(), wal.clone()],
            Vec::<PathBuf>::new(),
            vec![executable.clone()],
            false,
            false,
            false,
            false,
            false,
            octopus_descriptors::ProcessSandboxMode::Enforced,
        )
        .unwrap()
        .with_writable_raw_exact([shm.clone()])
        .unwrap();
        let policy = project(&authority, &executable).unwrap();
        let profile_text = policy
            .apparmor_profile(
                &format!("octopus-1000-{}", "d".repeat(64)),
                1000,
                UnixSocketMediation::FamilyAndType,
            )
            .unwrap();
        assert!(profile_text.contains(&format!("  \"{}\" rk,\n", db.display())));
        assert!(profile_text.contains(&format!("  \"{}\" rk,\n", wal.display())));
        assert!(profile_text.contains(&format!("  \"{}\" rwkl,\n", shm.display())));
        assert!(
            !profile_text.contains(".octopus-publication"),
            "writable_raw_exact must not generate publication coordination rules: {profile_text}"
        );
        assert!(
            !policy.files.iter().any(|rule| matches!(
                rule.access,
                FileAccess::CreateDirectory | FileAccess::CreatePrivateDirectory
            )),
            "writable_raw_exact must not generate CreateDirectory rules"
        );
    }
}
