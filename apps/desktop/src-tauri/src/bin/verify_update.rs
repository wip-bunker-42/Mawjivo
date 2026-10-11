use mawjivo_lib::{service_artifact::sha256, updates::{MAX_UPDATE_BYTES, verify_signed_release}};
fn main() {
    if run().is_err() {
        eprintln!("RELEASE_SIGNATURE_INVALID");
        std::process::exit(1);
    }
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 4 { return Err("expected installer, signature, public key and version".into()); }
    let size = std::fs::metadata(&args[0])?.len();
    if size == 0 || size > MAX_UPDATE_BYTES || std::fs::metadata(&args[1])?.len() > 4096 || std::fs::metadata(&args[2])?.len() > 4096 { return Err("invalid file size".into()); }
    let bytes = std::fs::read(&args[0])?;
    let signature = std::fs::read_to_string(&args[1])?;
    let public_key = std::fs::read_to_string(&args[2])?;
    verify_signed_release(&bytes, signature.trim(), public_key.trim(), &args[3]).map_err(|_| "invalid signature")?;
    println!("{}", serde_json::json!({"valid":true,"version":args[3],"bytes":bytes.len(),"sha256":sha256(&bytes)}));
    Ok(())
}
