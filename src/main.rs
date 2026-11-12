//! `bmo-remote`: the service and its command in one binary (`docs/api.md`, 「The command」).

use std::path::PathBuf;
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
  /// Prints how a console reaches the service, as one JSON object, for a deployment's console probe.
  #[command(name = "console-reach")]
  ConsoleReach,
  /// The nouns this command carries, one a line, as `bmo` asks a unit command.
  Nouns,
  /// Moves the old archive's kept values from the item's export into this service's store (TODO #1923).
  Import {
    /// The export directory the item's export hand wrote.
    #[arg(long)]
    export: PathBuf,
    /// The store's SQLite file; made and migrated where it does not stand.
    #[arg(long)]
    database: PathBuf,
    /// Reads the export and reports what it would write, writing nothing.
    #[arg(long)]
    dry_run: bool,
  },
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
    // The import reads its own arguments and never the deployment's settings.
    Word::Import {
      export,
      database,
      dry_run,
    } => {
      return match bmo_remote::import::run(&database, &export, dry_run).await {
        Ok(report) => {
          report.lines().iter().for_each(|line| println!("{line}"));
          if report.sample.failures.is_empty() { ExitCode::SUCCESS } else { ExitCode::FAILURE }
        }
        Err(why) => {
          eprintln!("bmo-remote: {why}");
          ExitCode::FAILURE
        }
      };
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
    Word::ConsoleReach => {
      println!("{}", command::console_reach(&settings));
      Ok(())
    }
    Word::Import { .. } => unreachable!("the import is answered before the settings are read"),
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
