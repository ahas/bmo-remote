//! The desktop: the relay the browser's RDP client reaches this machine's desktop through, speaking
//! RDCleanPath to the browser and RDP to the desktop (`docs/remote.md`, 「The desktop」).

pub mod client_info;
pub mod framing;
pub mod input_method;
pub mod negotiation;
pub mod nla;
pub mod pointers;
pub mod quality;
pub mod rdcleanpath;
pub mod redirection;
pub mod sidecar;
