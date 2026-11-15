//! The time bonus is a fraction of the drawn deadline, not a per-tick rate:
//! two sessions with the same need, the same use levels and the same share of
//! their deadline left must score the same, however long that deadline was.

use loo_core::{session_score, weighted_score, Config, Session, SessionStatus};
use loo_proto::Need;
use std::collections::BTreeMap;

/// A session that drew `span` ticks. One level-1 use tick keeps the weighted
/// score equal to the base score.
fn scored_session(need: Need, span: u64) -> Session {
    let mut session = Session::fresh(1, 1, SessionStatus::Inside, BTreeMap::new());
    session.need = Some(need);
    session.deadline_span = span;
    session.deadline = span;
    session.use_levels = vec![1];
    session.score = 0;
    session
}

fn at(span: u64, remaining: u64) -> u64 {
    span.checked_sub(remaining)
        .expect("remaining fits the span")
}

#[test]
fn same_remaining_ratio_scores_the_same_across_deadline_spans() {
    let cfg = Config::default();
    let base = u64::from(cfg.need.base_score_urine);

    let short = scored_session(Need::Urine, 36);
    let long = scored_session(Need::Urine, 60);
    assert_eq!(
        session_score(&short, &cfg, at(36, 18)),
        session_score(&long, &cfg, at(60, 30)),
        "half a deadline left pays the same share in a 36-tick and a 60-tick session"
    );
    assert_eq!(
        session_score(&short, &cfg, at(36, 18)),
        (base + base * u64::from(cfg.need.time_bonus_percent) / 100 / 2) as u32,
        "half of the 50% cap"
    );

    let full = scored_session(Need::Urine, 36);
    let half = scored_session(Need::Urine, 36);
    let full_score = u64::from(session_score(&full, &cfg, at(36, 36)));
    let half_score = u64::from(session_score(&half, &cfg, at(36, 18)));
    assert_eq!(
        full_score - half_score,
        base * u64::from(cfg.need.time_bonus_percent) / 100 / 2,
        "finishing at once pays exactly twice the half-deadline bonus"
    );
}

#[test]
fn time_bonus_never_exceeds_the_configured_fraction() {
    let cfg = Config::default();
    let base = u64::from(cfg.need.base_score_urine);
    let cap = base * u64::from(cfg.need.time_bonus_percent) / 100;

    for span in 1..=90u64 {
        let session = scored_session(Need::Urine, span);
        assert_eq!(
            u64::from(weighted_score(
                cfg.need.base_score_urine,
                &session.use_levels,
                &cfg
            )),
            base
        );
        for remaining in 0..=span {
            let score = u64::from(session_score(&session, &cfg, at(span, remaining)));
            let bonus = score - base;
            assert!(
                bonus <= cap,
                "span {span}, remaining {remaining}: bonus {bonus} exceeds {cap}"
            );
            assert_eq!(
                bonus,
                (base * u64::from(cfg.need.time_bonus_percent) * remaining + 100 * span / 2)
                    / (100 * span),
                "span {span}, remaining {remaining}: the bonus is the rounded ratio"
            );
        }
    }

    let no_span = scored_session(Need::Urine, 0);
    assert_eq!(
        session_score(&no_span, &cfg, 0),
        cfg.need.base_score_urine,
        "a session without a drawn span pays no time bonus"
    );
}
