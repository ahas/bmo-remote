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
  /// Opens the store and answers the routes and sockets.
  Serve,
  /// Whether the service the settings name answers ready; ends 0 where it does.
  Health,
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
    Word::Health => bmo_remote::health::ask(&settings).await,
  };

  match done {
    Ok(()) => ExitCode::SUCCESS,
    Err(why) => {
      eprintln!("bmo-remote: {why}");
      ExitCode::FAILURE
    }
  }
}
