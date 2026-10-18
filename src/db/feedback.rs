//! Feedback: one instance-wide list, capped (the API at
//! [`FEEDBACK_MAX`](crate::model::FEEDBACK_MAX) rows).

use super::prelude::*;
use crate::model::{CheckedFeedback, Feedback, FeedbackStatus};

const FEEDBACK_COLS: &str = "id, kind, text, status, created_at";

fn feedback_row(r: &Row) -> rusqlite::Result<Feedback> {
    Ok(Feedback {
        id: r.get(0)?,
        kind: r.get(1)?,
        text: r.get(2)?,
        status: r.get(3)?,
        created_at: r.get(4)?,
    })
}

/// Keep feedback, at most `max` rows. Full, the oldest pulled row makes
/// room; with every row still open, 409 `feedback_full`.
pub fn feedback_insert(
    conn: &mut Connection,
    f: &CheckedFeedback,
    max: u32,
) -> Result<Feedback, Error> {
    let tx = write(conn)?;
    let rows: u32 = tx.query_row("SELECT count(*) FROM feedback", [], |r| r.get(0))?;
    if rows >= max {
        let freed = tx.execute(
            "DELETE FROM feedback WHERE id = (
                 SELECT min(id) FROM feedback WHERE status = 'pulled')",
            [],
        )?;
        if freed == 0 {
            return Err(Error::conflict(
                Conflict::FeedbackFull,
                format!("{max} notes wait already: ask the maintainer to pull them"),
            ));
        }
    }
    let feedback = tx.query_row(
        &format!("INSERT INTO feedback (kind, text) VALUES (?, ?) RETURNING {FEEDBACK_COLS}"),
        params![f.kind, f.text],
        feedback_row,
    )?;
    tx.commit()?;
    Ok(feedback)
}

/// Feedback with `status` (any without), oldest first.
///
/// # Errors
/// A database error (no `feedback` table: a database from before it).
pub fn feedback_list(
    conn: &Connection,
    status: Option<FeedbackStatus>,
) -> Result<Vec<Feedback>, Error> {
    Ok(conn
        .prepare_cached(&format!(
            "SELECT {FEEDBACK_COLS} FROM feedback WHERE ?1 IS NULL OR status = ?1 ORDER BY id"
        ))?
        .query_map([status], feedback_row)?
        .collect::<rusqlite::Result<_>>()?)
}

/// How much feedback is open.
///
/// # Errors
/// A database error.
pub fn feedback_open_count(conn: &Connection) -> Result<i64, Error> {
    Ok(conn.query_row(
        "SELECT count(*) FROM feedback WHERE status = 'open'",
        [],
        |r| r.get(0),
    )?)
}

/// Mark `ids` pulled, in one transaction: the CLI calls it once they are
/// printed, so feedback that never reached the maintainer stays open.
///
/// # Errors
/// A database error; nothing is marked then.
pub fn feedback_pull(conn: &mut Connection, ids: &[i64]) -> Result<(), Error> {
    let tx = write(conn)?;
    {
        let mut pull = tx.prepare_cached(
            "UPDATE feedback SET status = 'pulled' WHERE id = ? AND status = 'open'",
        )?;
        for id in ids {
            pull.execute([id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::FeedbackKind;

    fn db() -> Connection {
        crate::db::open(std::path::Path::new(":memory:")).unwrap()
    }

    fn add(conn: &mut Connection, text: &str) -> Result<Feedback, Error> {
        let f = CheckedFeedback {
            kind: FeedbackKind::Bug,
            text: text.to_owned(),
        };
        feedback_insert(conn, &f, 3)
    }

    fn texts(conn: &Connection) -> Vec<(String, FeedbackStatus)> {
        feedback_list(conn, None)
            .unwrap()
            .into_iter()
            .map(|f| (f.text, f.status))
            .collect()
    }

    #[test]
    fn feedback_full_evicts_the_oldest_pulled_only() {
        use FeedbackStatus::{Open, Pulled};
        let mut conn = db();
        let ids: Vec<i64> = ["a", "b", "c"]
            .iter()
            .map(|t| add(&mut conn, t).unwrap().id)
            .collect();
        feedback_pull(&mut conn, &[ids[0], ids[2]]).unwrap();
        add(&mut conn, "d").unwrap();
        assert_eq!(
            texts(&conn),
            [("b".into(), Open), ("c".into(), Pulled), ("d".into(), Open)]
        );
        add(&mut conn, "e").unwrap();
        assert_eq!(
            texts(&conn),
            [("b".into(), Open), ("d".into(), Open), ("e".into(), Open)]
        );
        let full = add(&mut conn, "f").unwrap_err();
        assert!(
            matches!(
                full,
                Error::Conflict {
                    kind: Conflict::FeedbackFull,
                    ..
                }
            ),
            "{full:?}"
        );
        assert_eq!(texts(&conn).len(), 3);
    }

    #[test]
    fn pull_marks_only_the_ids_given() {
        let mut conn = db();
        let a = add(&mut conn, "a").unwrap().id;
        add(&mut conn, "b").unwrap();
        feedback_pull(&mut conn, &[a]).unwrap();
        assert_eq!(
            feedback_list(&conn, Some(FeedbackStatus::Open))
                .unwrap()
                .into_iter()
                .map(|f| f.text)
                .collect::<Vec<_>>(),
            ["b"]
        );
    }
}
