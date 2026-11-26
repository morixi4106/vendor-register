use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    assert_eq!(env::var("HOST").unwrap(), env::var("TARGET").unwrap());
    let out = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let binary = out.join(if cfg!(windows) { "wal-contract.exe" } else { "wal-contract" });
    let compiler = cc::Build::new().opt_level(2).warnings(true).get_compiler();
    fs::write(out.join("compiler-path.txt"), compiler.path().to_str().unwrap()).unwrap();
    let mut command = compiler.to_command();
    command.arg("wal-contract.c");
    if compiler.is_like_msvc() {
        command.arg("/W4").arg("/WX").arg(format!("/Fe{}", binary.display()));
    } else {
        command.args(["-std=c99", "-Wall", "-Wextra", "-Werror", "-o"]).arg(&binary);
    }
    fs::write(out.join("compiler-command.txt"), format!("{:?}\n", command)).unwrap();
    let result = command.output().expect("C compiler unavailable");
    fs::write(out.join("compiler.stdout.log"), &result.stdout).unwrap();
    fs::write(out.join("compiler.stderr.log"), &result.stderr).unwrap();
    assert!(result.status.success(), "C contract compile failed: {}", String::from_utf8_lossy(&result.stderr));
    let result = Command::new(&binary).output().expect("C contract unavailable");
    fs::write(out.join("contract.stdout.log"), &result.stdout).unwrap();
    fs::write(out.join("contract.stderr.log"), &result.stderr).unwrap();
    assert!(result.status.success(), "C contract failed");
    let output = String::from_utf8(result.stdout).unwrap().replace("\r\n", "\n");
    assert_eq!(output, "sqlite-wal-cases 72 baseline-stale-tail 24 fixed-zero-tail 24\n");
    println!("cargo:rustc-env=WAL_CONTRACT_OUTPUT={}", output.trim());
    println!("cargo:rerun-if-changed=wal-contract.c");
}
