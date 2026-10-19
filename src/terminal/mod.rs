//! The terminal sessions: the tmux server that holds them, the routes that manage them, and the socket a
//! viewer watches one through (`docs/remote.md`, 「Terminal sessions」).

pub mod pty;
pub mod routes;
pub mod socket;
pub mod tmux;
