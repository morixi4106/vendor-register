#[cfg(test)]
mod tests {
    use native_tls::{Identity, Protocol};
    use std::time::Duration;
    use tiberius::{Client, Config, EncryptionLevel};
    use tiberius::error::Error;
    use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
    use tokio_util::compat::TokioAsyncReadCompatExt;

    fn packet(payload: &[u8]) -> Vec<u8> {
        let length = u16::try_from(8 + payload.len()).unwrap().to_be_bytes();
        let mut bytes = vec![4, 1, length[0], length[1], 0, 0, 1, 0];
        bytes.extend_from_slice(payload);
        bytes
    }

    async fn frame<S: AsyncRead + Unpin>(stream: &mut S) -> std::io::Result<(u8, usize)> {
        let mut header = [0u8; 8];
        stream.read_exact(&mut header).await?;
        let length = u16::from_be_bytes([header[2], header[3]]) as usize;
        assert!((8..=32768).contains(&length), "bounded synthetic TDS frame");
        let mut payload = vec![0u8; length - 8];
        stream.read_exact(&mut payload).await?;
        Ok((header[0], payload.len()))
    }

    async fn probe(name: &str, identity: &[u8], trust_root: bool, hostname: &str, expected: &[&str]) {
        let (client_io, server_io) = tokio::io::duplex(65536);
        let identity = Identity::from_pkcs12(identity, "synthetic-fixture-only").unwrap();
        let mut builder = native_tls::TlsAcceptor::builder(identity);
        // A fixed TLS 1.2 control on both platform-native TLS implementations.
        builder.min_protocol_version(Some(Protocol::Tlsv12));
        builder.max_protocol_version(Some(Protocol::Tlsv12));
        let acceptor = tokio_native_tls::TlsAcceptor::from(builder.build().unwrap());
        let mut config = Config::new();
        config.host(hostname);
        config.encryption(EncryptionLevel::Strict);
        if trust_root {
            config.trust_cert_ca_bundle(include_bytes!("../certificates/root.der").to_vec());
        }
        let server = async {
            let mut tls = match acceptor.accept(server_io).await {
                Ok(tls) => tls,
                Err(_) => return (0, 0),
            };
            let (kind, _) = match frame(&mut tls).await {
                Ok(frame) => frame,
                Err(_) => return (0, 0),
            };
            assert_eq!(kind, 0x12, "first decrypted data must be PRELOGIN");
            tls.write_all(&packet(&[1, 0, 6, 0, 1, 255, 3])).await.unwrap();
            tls.flush().await.unwrap();
            let (kind, _) = frame(&mut tls).await.unwrap();
            assert_eq!(kind, 0x10, "LOGIN follows verified TLS and PRELOGIN");
            tls.write_all(&packet(&[0xfd, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).await.unwrap();
            tls.flush().await.unwrap();
            (1, 1)
        };
        let client = async { Client::connect(config, client_io.compat()).await.map(|_| ()) };
        let (result, observed) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(client, server)
        }).await.expect("bounded memory-only TLS handshake");
        if expected.is_empty() {
            result.unwrap();
            assert_eq!(observed, (1, 1));
            eprintln!("OJA_TDS_TLS scenario={name} success=true prelogin=1 login=1");
        } else {
            match result {
                Err(Error::Tls(message)) => {
                    let message = message.to_lowercase();
                    let reason_matches = if cfg!(windows) {
                        let code = match name {
                            "untrusted" => -2146762487i32, // CERT_E_UNTRUSTEDROOT
                            "hostname" => -2146762481i32, // CERT_E_CN_NO_MATCH
                            "expired" | "future" => -2146762495i32, // CERT_E_EXPIRED
                            _ => panic!("unbound certificate rejection scenario"),
                        };
                        message.ends_with(&format!("(os error {code})"))
                    } else {
                        expected.iter().any(|part| message.contains(part))
                    };
                    assert!(reason_matches, "unexpected certificate error for {name}: {message}");
                    eprintln!("OJA_TDS_TLS_ERROR scenario={name} detail={message}");
                }
                other => panic!("expected certificate TLS error for {name}, got {other:?}"),
            }
            assert_eq!(observed, (0, 0), "no decrypted TDS or LOGIN before certificate validation");
            eprintln!("OJA_TDS_TLS scenario={name} success=false prelogin=0 login=0");
        }
    }

    #[tokio::test]
    async fn trusted_ca_and_matching_hostname_complete_encrypted_login() {
        probe("trusted", include_bytes!("../certificates/valid.pfx"), true, "tds.fixture.invalid", &[]).await;
    }

    #[tokio::test]
    async fn untrusted_ca_is_rejected_before_tds_data() {
        probe("untrusted", include_bytes!("../certificates/valid.pfx"), false, "tds.fixture.invalid", &["self-signed", "unable to get local issuer", "untrusted root", "0x800b0109", "0x80090325"]).await;
    }

    #[tokio::test]
    async fn wrong_hostname_is_rejected_before_tds_data() {
        probe("hostname", include_bytes!("../certificates/valid.pfx"), true, "wrong.fixture.invalid", &["hostname mismatch", "name mismatch", "wrong principal", "0x800b010f", "0x80090322"]).await;
    }

    #[tokio::test]
    async fn expired_certificate_is_rejected_before_tds_data() {
        probe("expired", include_bytes!("../certificates/expired.pfx"), true, "tds.fixture.invalid", &["certificate has expired", "expired", "0x800b0101"]).await;
    }

    #[tokio::test]
    async fn future_certificate_is_rejected_before_tds_data() {
        probe("future", include_bytes!("../certificates/future.pfx"), true, "tds.fixture.invalid", &["not yet valid", "not within its validity period", "0x800b0101"]).await;
    }
}
