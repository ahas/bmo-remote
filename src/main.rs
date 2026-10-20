//! `bmo-remote`: the service and its command in one binary (`docs/api.md`, 「The command」).

use std::process::ExitCode;

use bmo_remote::command::{self, DesktopArgs, NOUNS};
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
  /// Prints the OpenAPI document the code generates.
  Openapi,
  /// The nouns this command carries, one a line, as `bmo` asks a unit command.
  Nouns,
  /// The machine's words this command carries.
  Node {
    #[command(subcommand)]
    word: NodeWord,
  },
  /// Which port the desktop relay dials, as `node remote-desktop` tells and sets it.
  #[command(name = "remote-desktop")]
  RemoteDesktop(DesktopArgs),
}

#[derive(Subcommand)]
enum NodeWord {
  /// Which port the desktop relay dials: told with no flag, changed with --port, or back to the settings'
  /// port with --default.
  #[command(name = "remote-desktop")]
  RemoteDesktop(DesktopArgs),
}

#[tokio::main]
async fn main() -> ExitCode {
  // Usage the command does not take ends 1, as every refusal of it does; help and the version end 0.
  let command = match Command::try_parse() {
    Ok(command) => command,
    Err(why) => {
      let _ = why.print();
      return if why.use_stderr() { ExitCode::FAILURE } else { ExitCode::SUCCESS };
    }
  };

  match command.word {
    Word::Nouns => {
      NOUNS.iter().for_each(|noun| println!("{noun}"));
      return ExitCode::SUCCESS;
    }
    Word::Openapi => {
      print!("{}", bmo_remote::openapi::openapi_json());
      return ExitCode::SUCCESS;
    }
    _ => {}
  }

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
    Word::Nouns | Word::Openapi => Ok(()),
    Word::Node {
      word: NodeWord::RemoteDesktop(asked),
    }
    | Word::RemoteDesktop(asked) => return told(command::remote_desktop(settings, asked).await),
  };

  match done {
    Ok(()) => ExitCode::SUCCESS,
    Err(why) => {
      eprintln!("bmo-remote: {why}");
      ExitCode::FAILURE
    }
  }
}

/// What `node remote-desktop` printed, and how it ended.
fn told(done: Result<String, String>) -> ExitCode {
  match done {
    Ok(line) => {
      println!("{line}");
      ExitCode::SUCCESS
    }
    Err(why) => {
      eprintln!("{why}");
      ExitCode::FAILURE
    }
  }
}
