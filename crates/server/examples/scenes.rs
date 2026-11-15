use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::PathBuf;

use loo_core::{
    map, step, Agent, Config, Event, Intent, IntentKind, JoinCommand, Object, Session, SiteKind,
    WorldState,
};
use loo_proto::{
    AgentId, AgentPose, Dir, Nick, ObjectKind, PlayerKind, Pos, Projection, ProjectionAgent,
    ProjectionObject, TerrainResponse,
};
use loo_server::projection::{build, terrain_rows, AgentPublic};

const DEFAULT_MAP: &str = include_str!("../../../maps/default.txt");

fn main() {
    let dir = PathBuf::from(std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: cargo run -p loo-server --example scenes -- <output dir>");
        std::process::exit(2);
    }));
    std::fs::create_dir_all(&dir)
        .unwrap_or_else(|error| panic!("create {}: {error}", dir.display()));
    let scenes = [
        shacks(),
        missing_wall(),
        wall_half(),
        upgrading(),
        using(),
        windup(),
        states(),
        crowd(),
    ];
    for scene in scenes {
        let value = serde_json::json!({
            "terrain": scene.terrain,
            "prev": scene.prev,
            "cur": scene.cur,
        });
        let path = dir.join(format!("{}.json", scene.name));
        let text = serde_json::to_string_pretty(&value).expect("scene serialises");
        std::fs::write(&path, text)
            .unwrap_or_else(|error| panic!("write {}: {error}", path.display()));
        println!("{}", path.display());
    }
}

struct Scene {
    name: &'static str,
    terrain: TerrainResponse,
    prev: Projection,
    cur: Projection,
}

fn check(ok: bool, what: &str) {
    assert!(ok, "scene check failed: {what}");
}

struct Sim {
    cfg: Config,
    world: WorldState,
    publics: BTreeMap<AgentId, AgentPublic>,
    seed: u64,
    events: Vec<Event>,
    prev: Option<(WorldState, Vec<Event>)>,
}

impl Sim {
    fn new() -> Self {
        let def = map::parse(DEFAULT_MAP).expect("default map parses");
        Self {
            cfg: Config::default(),
            world: WorldState::new(def),
            publics: BTreeMap::new(),
            seed: 1,
            events: Vec::new(),
            prev: None,
        }
    }

    fn join(&mut self, agent: AgentId, score_total: u32) {
        let cmd = JoinCommand {
            agent,
            nick: Nick::parse(&format!("agent-{agent}")).expect("nick is valid"),
            session: agent,
            score_total,
        };
        let (world, _, _) = loo_core::join(&self.world, &cmd, &self.cfg, 0, self.seed)
            .unwrap_or_else(|reject| panic!("join {agent}: {}", reject.message));
        self.world = world;
        self.publics.insert(
            agent,
            AgentPublic {
                sent_by: None,
                kind: PlayerKind::Ai,
                color: None,
            },
        );
    }

    fn tick(&mut self, intents: &[Intent]) {
        self.seed += 1;
        let (next, events) = step(&self.world, intents, self.seed, &self.cfg);
        let before = std::mem::replace(&mut self.world, next);
        let before_events = std::mem::replace(&mut self.events, events);
        self.prev = Some((before, before_events));
    }

    fn act(&mut self, agent: AgentId, kind: IntentKind) {
        self.tick(&[Intent { agent, kind }]);
    }

    fn wait_until(&mut self, what: &str, done: impl Fn(&Sim) -> bool) {
        for _ in 0..200 {
            if done(self) {
                return;
            }
            self.tick(&[]);
        }
        panic!("gave up waiting for {what}");
    }

    fn agent(&self, id: AgentId) -> &Agent {
        &self.world.agents[&id]
    }

    fn pos(&self, id: AgentId) -> Pos {
        self.agent(id).pos.expect("agent stands on the map")
    }

    fn place(&mut self, id: AgentId, pos: Pos) {
        check(
            self.world.map.in_bounds(pos) && walkable(&self.world, pos),
            "placed agent lands on a walkable cell",
        );
        check(
            self.world.agent_at(pos).is_none(),
            "placed agent lands on a free cell",
        );
        self.world
            .agents
            .get_mut(&id)
            .expect("placed agent exists")
            .pos = Some(pos);
    }

    fn walk(&mut self, id: AgentId, to: Pos) {
        for _ in 0..200 {
            let idle = self.agent(id).action.is_none();
            if idle && self.pos(id) == to {
                return;
            }
            match idle.then(|| route(&self.world, self.pos(id), to)).flatten() {
                Some(dirs) => self.act(
                    id,
                    IntentKind::Move {
                        dirs,
                        label: format!("walk to {to}"),
                    },
                ),
                None => self.tick(&[]),
            }
        }
        panic!("agent {id} never reached {to}");
    }

    fn set_deadline(&mut self, id: AgentId, deadline: u64) {
        self.world
            .sessions
            .values_mut()
            .find(|session: &&mut Session| session.agent == id)
            .expect("agent has a session")
            .deadline = deadline;
    }

    fn routing_intents(&self, targets: &BTreeMap<AgentId, Pos>) -> Vec<Intent> {
        let mut intents = Vec::new();
        for (id, target) in targets {
            let Some(agent) = self.world.agents.get(id) else {
                continue;
            };
            if !self.world.is_inside(*id) || agent.action.is_some() {
                continue;
            }
            let Some(pos) = agent.pos else {
                continue;
            };
            if pos == *target {
                continue;
            }
            let Some(dirs) = route(&self.world, pos, *target) else {
                continue;
            };
            intents.push(Intent {
                agent: *id,
                kind: IntentKind::Move {
                    dirs,
                    label: format!("walk to {target}"),
                },
            });
        }
        intents
    }

    fn finish(self, name: &'static str) -> Scene {
        let (prev_world, prev_events) =
            self.prev.as_ref().expect("a scene takes at least one tick");
        Scene {
            name,
            terrain: terrain_rows(&self.world),
            prev: build(&self.cfg, prev_world, &self.publics, prev_events),
            cur: build(&self.cfg, &self.world, &self.publics, &self.events),
        }
    }
}

fn walkable(world: &WorldState, pos: Pos) -> bool {
    world.map.in_bounds(pos) && !world.object_at(pos).is_some_and(|o| o.blocks_movement())
}

fn route(world: &WorldState, from: Pos, to: Pos) -> Option<Vec<Dir>> {
    let mut came_from: BTreeMap<Pos, (Pos, Dir)> = BTreeMap::new();
    let mut seen = BTreeSet::from([from]);
    let mut queue = VecDeque::from([from]);
    while let Some(pos) = queue.pop_front() {
        if pos == to {
            break;
        }
        for dir in Dir::ALL {
            let next = pos.step(dir);
            if walkable(world, next) && world.agent_at(next).is_none() && seen.insert(next) {
                came_from.insert(next, (pos, dir));
                queue.push_back(next);
            }
        }
    }
    if !seen.contains(&to) {
        return None;
    }
    let mut dirs = Vec::new();
    let mut at = to;
    while at != from {
        let (previous, dir) = came_from[&at];
        dirs.push(dir);
        at = previous;
    }
    dirs.reverse();
    Some(dirs)
}

fn cell(projection: &Projection, pos: Pos) -> Option<&ProjectionObject> {
    projection.objects.iter().find(|object| object.pos == pos)
}

fn agent_of(projection: &Projection, id: AgentId) -> &ProjectionAgent {
    projection
        .agents
        .iter()
        .find(|agent| agent.id == id)
        .expect("agent is on the projection")
}

fn wall_at(world: &WorldState, pos: Pos) -> bool {
    matches!(world.object_at(pos), Some(Object::Wall { .. }))
}

fn door_at(world: &WorldState, pos: Pos) -> bool {
    matches!(world.object_at(pos), Some(Object::Door { .. }))
}

fn toilet_at(world: &WorldState, pos: Pos) -> bool {
    matches!(world.object_at(pos), Some(Object::Toilet { .. }))
}

fn wall_site_work(world: &WorldState, pos: Pos) -> Option<u32> {
    match world.object_at(pos) {
        Some(Object::Site {
            kind: SiteKind::Wall,
            work,
        }) => Some(work),
        _ => None,
    }
}

fn use_done(world: &WorldState, id: AgentId) -> u32 {
    world
        .session_of(id)
        .map_or(0, |session| session.use_ticks_done)
}

fn shacks() -> Scene {
    let mut sim = Sim::new();
    sim.join(1, 0);
    sim.walk(1, Pos::new(10, 15));
    sim.join(2, 0);
    sim.walk(2, Pos::new(17, 15));
    let scene = sim.finish("shacks");
    check(scene.cur.agents.len() == 2, "two agents are inside");
    for agent in &scene.cur.agents {
        check(agent.pose == AgentPose::Idle, "both agents stand idle");
    }
    scene
}

fn missing_wall() -> Scene {
    let wall = Pos::new(31, 19);
    let mut sim = Sim::new();
    sim.join(1, 0);
    sim.place(1, Pos::new(32, 19));
    sim.act(1, IntentKind::Demolish { target: wall });
    sim.wait_until("the wall to come down", |sim| {
        sim.world.object_at(wall).is_none()
    });
    let scene = sim.finish("missing-wall");
    check(
        cell(&scene.prev, wall).is_some_and(|object| object.kind == ObjectKind::Wall),
        "the wall stands one tick before the scene",
    );
    check(cell(&scene.cur, wall).is_none(), "the wall is gone");
    scene
}

fn wall_half() -> Scene {
    let toilet = Pos::new(37, 8);
    let toilet_wall = Pos::new(37, 7);
    let lone_wall = Pos::new(41, 12);
    let lone_door = Pos::new(40, 13);
    let lone_site = Pos::new(40, 11);
    let mut sim = Sim::new();
    sim.join(1, 0);
    sim.place(1, toilet);
    sim.join(2, 0);
    sim.place(2, Pos::new(40, 12));
    sim.tick(&[
        Intent {
            agent: 1,
            kind: IntentKind::Build {
                kind: SiteKind::Toilet,
                target: toilet,
            },
        },
        Intent {
            agent: 2,
            kind: IntentKind::Build {
                kind: SiteKind::Wall,
                target: lone_wall,
            },
        },
    ]);
    sim.wait_until("the toilet and the first lone wall", |sim| {
        toilet_at(&sim.world, toilet) && wall_at(&sim.world, lone_wall)
    });
    let north_walk = route(&sim.world, toilet, Pos::new(37, 6)).expect("a way north of the toilet");
    sim.tick(&[
        Intent {
            agent: 1,
            kind: IntentKind::Move {
                dirs: north_walk,
                label: "walk north of the toilet".to_string(),
            },
        },
        Intent {
            agent: 2,
            kind: IntentKind::Build {
                kind: SiteKind::Door,
                target: lone_door,
            },
        },
    ]);
    sim.wait_until("the walk and the lone door", |sim| {
        sim.agent(1).action.is_none() && door_at(&sim.world, lone_door)
    });
    sim.tick(&[
        Intent {
            agent: 1,
            kind: IntentKind::Build {
                kind: SiteKind::Wall,
                target: toilet_wall,
            },
        },
        Intent {
            agent: 2,
            kind: IntentKind::Build {
                kind: SiteKind::Wall,
                target: lone_site,
            },
        },
    ]);
    sim.wait_until("both wall sites to take their first work", |sim| {
        wall_site_work(&sim.world, toilet_wall) == Some(1)
            && wall_site_work(&sim.world, lone_site) == Some(1)
    });
    let scene = sim.finish("wall-half");
    let site = cell(&scene.cur, toilet_wall).expect("toilet wall site is on the projection");
    check(
        site.site == Some(ObjectKind::Wall) && site.progress * 2 == site.progress_total,
        "toilet wall site is exactly half built",
    );
    let lone = cell(&scene.cur, lone_site).expect("lone wall site is on the projection");
    check(
        lone.site == Some(ObjectKind::Wall) && lone.progress * 2 == lone.progress_total,
        "lone wall site is exactly half built",
    );
    check(
        cell(&scene.cur, toilet).is_some_and(|object| object.kind == ObjectKind::Toilet),
        "the toilet is finished",
    );
    check(
        cell(&scene.cur, lone_wall)
            .is_some_and(|object| object.kind == ObjectKind::Wall && object.site.is_none()),
        "the lone wall is finished",
    );
    check(
        cell(&scene.cur, lone_door)
            .is_some_and(|object| object.kind == ObjectKind::Door && object.site.is_none()),
        "the lone door is finished",
    );
    scene
}

fn upgrading() -> Scene {
    let toilet = Pos::new(13, 10);
    let mut sim = Sim::new();
    sim.join(1, 1000);
    sim.place(1, toilet);
    sim.act(1, IntentKind::Upgrade { target: toilet });
    sim.tick(&[]);
    let scene = sim.finish("upgrading");
    let object = cell(&scene.cur, toilet).expect("toilet is on the projection");
    check(object.progress > 0, "upgrade work is under way");
    check(object.level == 1, "the toilet is still level 1");
    check(
        agent_of(&scene.cur, 1).level == 2,
        "the upgrading agent is level 2",
    );
    scene
}

fn using() -> Scene {
    let toilet = Pos::new(13, 10);
    let door = Pos::new(13, 11);
    let mut sim = Sim::new();
    sim.join(1, 0);
    sim.place(1, Pos::new(13, 12));
    sim.tick(&[]);
    sim.walk(1, toilet);
    sim.act(
        1,
        IntentKind::Door {
            target: door,
            open: false,
        },
    );
    sim.act(1, IntentKind::Use { target: toilet });
    sim.wait_until("two ticks of use", |sim| use_done(&sim.world, 1) >= 2);
    let scene = sim.finish("using");
    let user = agent_of(&scene.cur, 1);
    check(
        user.pose == AgentPose::Using,
        "the agent is using the toilet",
    );
    check(user.use_done == 2, "the use is on its second tick");
    check(
        cell(&scene.cur, door)
            .is_some_and(|object| object.kind == ObjectKind::Door && !object.open),
        "the south door is shut",
    );
    scene
}

fn windup() -> Scene {
    let mut sim = Sim::new();
    sim.join(1, 0);
    sim.place(1, Pos::new(18, 12));
    sim.join(2, 0);
    sim.place(2, Pos::new(19, 12));
    sim.act(
        1,
        IntentKind::Attack {
            target: Pos::new(19, 12),
        },
    );
    for _ in 0..3 {
        sim.tick(&[]);
    }
    let scene = sim.finish("windup");
    let attacker = agent_of(&scene.cur, 1);
    check(
        attacker.pose == AgentPose::Attacking,
        "the attacker is in its windup",
    );
    check(
        attacker
            .attack_land_tick
            .is_some_and(|land| land > scene.cur.tick),
        "the attack has not landed yet",
    );
    scene
}

fn states() -> Scene {
    let mut sim = Sim::new();
    sim.join(4, 0);
    sim.place(4, Pos::new(30, 17));
    sim.tick(&[]);
    sim.walk(4, Pos::new(30, 19));
    sim.act(
        4,
        IntentKind::Door {
            target: Pos::new(30, 18),
            open: false,
        },
    );
    sim.act(
        4,
        IntentKind::Use {
            target: Pos::new(30, 19),
        },
    );
    sim.wait_until("two ticks of use", |sim| use_done(&sim.world, 4) >= 2);
    sim.act(
        4,
        IntentKind::Move {
            dirs: vec![Dir::N],
            label: "step out of the toilet".to_string(),
        },
    );

    sim.join(1, 0);
    sim.place(1, Pos::new(36, 24));
    sim.join(2, 0);
    sim.place(2, Pos::new(37, 24));
    sim.join(3, 0);
    sim.place(3, Pos::new(42, 8));
    sim.join(5, 0);
    sim.place(5, Pos::new(40, 4));
    sim.join(6, 0);
    sim.place(6, Pos::new(44, 26));

    sim.tick(&[
        Intent {
            agent: 1,
            kind: IntentKind::Attack {
                target: Pos::new(37, 24),
            },
        },
        Intent {
            agent: 6,
            kind: IntentKind::Move {
                dirs: vec![Dir::N; 10],
                label: "walk north".to_string(),
            },
        },
    ]);
    let landing = sim.world.tick + 6;
    sim.tick(&[]);
    sim.act(
        3,
        IntentKind::Defend {
            target: Pos::new(43, 8),
        },
    );
    while sim.world.tick < landing {
        sim.tick(&[]);
    }
    sim.set_deadline(5, sim.world.tick + 6);
    sim.tick(&[]);
    let scene = sim.finish("states");

    let stunned = agent_of(&scene.cur, 2);
    check(stunned.pose == AgentPose::Stunned, "the victim is stunned");
    check(
        agent_of(&scene.cur, 3).pose == AgentPose::Defending,
        "the defender is defending",
    );
    check(
        agent_of(&scene.cur, 4).recovery_deadline.is_some(),
        "the interrupted user has a recovery deadline",
    );
    check(
        agent_of(&scene.cur, 5).urgent,
        "the deadline agent is urgent",
    );
    check(
        agent_of(&scene.cur, 6).pose == AgentPose::Walking,
        "the walker is walking",
    );
    scene
}

fn crowd() -> Scene {
    let mut sim = Sim::new();
    let entrance = sim.world.entrance;
    let mut targets: BTreeMap<AgentId, Pos> = BTreeMap::new();
    for id in 1..=12u64 {
        while sim.world.agent_at(entrance).is_some() {
            let intents = sim.routing_intents(&targets);
            sim.tick(&intents);
        }
        sim.join(id, 0);
        let slot = (id - 1) as i32;
        targets.insert(id, Pos::new(34 + (slot % 4) * 3, 3 + (slot / 4) * 9));
        let intents = sim.routing_intents(&targets);
        sim.tick(&intents);
    }
    for id in 13..=22u64 {
        sim.join(id, 0);
    }
    let intents = sim.routing_intents(&targets);
    sim.tick(&intents);
    let scene = sim.finish("crowd");
    assert_eq!(
        scene.cur.counts.inside, 12,
        "inside count at the crowd tick: {:?}",
        scene.cur.counts
    );
    check(scene.cur.counts.queued == 10, "ten agents are queued");
    check(scene.cur.agents.len() == 12, "twelve agents are drawn");
    check(scene.cur.queue.len() == 10, "ten queue entries are drawn");
    let walking = scene
        .cur
        .agents
        .iter()
        .filter(|agent| agent.pose == AgentPose::Walking)
        .count();
    check(walking >= 6, "at least six agents are walking");
    scene
}
