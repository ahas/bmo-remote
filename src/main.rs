//! `bmo-remote`: the service and its command in one binary (`docs/api.md`, 「The command」).

use std::process::ExitCode;

use bmo_remote::settings::Settings;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "bmo-remote", version, about = "Terminal sessions and the remote desktop")]
struct Command {
  #[command(subcommand)]
  word: Word,
}

#[derive(Subcommand)]
enum Word {
  /// Answers the routes and sockets.
  Serve,
}

#[tokio::main]
async fn main() -> ExitCode {
  let command = Command::parse();
  let settings = match Settings::load() {
    Ok(settings) => settings,
    Err(why) => {
      eprintln!("bmo-remote: {why}");
      return ExitCode::FAILURE;
    }
  };
  let done = match command.word {
    Word::Serve => bmo_remote::serve(settings).await,
  };

  match done {
    Ok(()) => ExitCode::SUCCESS,
    Err(why) => {
      eprintln!("bmo-remote: {why}");
      ExitCode::FAILURE
    }
  }
}
