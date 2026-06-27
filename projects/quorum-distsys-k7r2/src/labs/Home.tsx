import { LABS } from './registry';

export function Home() {
  return (
    <div className="home">
      <section className="hero">
        <h1>
          Distributed systems, <span className="accent">made visible</span>.
        </h1>
        <p className="lede">
          Quorum is a deterministic distributed-systems simulator that runs entirely in your browser.
          Every node, message, timer, partition and clock tick is simulated on one seeded
          discrete-event kernel — so a whole run is a pure function of <code>(seed, scenario)</code>,
          perfectly reproducible and <b>scrubbable backwards and forwards in time</b>.
        </p>
        <p className="lede">
          The hard algorithms are implemented for real, not faked: Raft <em>and</em> Multi-Paxos
          consensus, <b>PBFT</b> and <b>HotStuff</b> Byzantine fault tolerance that survives
          actively-malicious replicas, a <b>Dynamo</b>-style always-writeable store with tunable
          <code>(N,R,W)</code> quorums, sloppy quorums + hinted handoff and vector-clock siblings, a
          Chord DHT, CRDTs, gossip / SWIM failure detection, vector clocks and atomic commit — plus
          <b> Snow / Avalanche</b> metastable consensus that reaches agreement by random subsampling
          instead of quorums, <b>Chandy–Lamport</b> consistent global snapshots of a running
          computation, and <b>Lamport</b> logical-clock mutual exclusion. Crash nodes, corrupt them,
          drop links, partition the cluster — and watch the safety invariants either hold or break, live.
        </p>
      </section>

      <section className="lab-cards">
        {LABS.map((l) => (
          <a key={l.id} className="lab-card" href={`#/${l.id}`}>
            <div className="lab-card-top">
              <span className="lab-card-ic">{l.icon}</span>
              <span className="lab-card-tag">{l.tag}</span>
            </div>
            <h3>{l.title}</h3>
            <p>{l.blurb}</p>
            <span className="lab-card-go">Open lab →</span>
          </a>
        ))}
      </section>

      <section className="home-foot">
        <h2>How it works</h2>
        <div className="how-grid">
          <div>
            <h4>One kernel, many protocols</h4>
            <p>
              A binary-heap event queue orders everything by virtual time; a seeded splitmix/mulberry
              RNG drives all randomness; named per-node timers support cancellation; nodes crash and
              restart with persistent vs. volatile state. Each protocol is just an implementation of a
              tiny <code>Protocol</code> interface.
            </p>
          </div>
          <div>
            <h4>A network you control</h4>
            <p>
              Per-link latency, jitter, drop rate and clean partitions. Messages can reorder. Click a
              link to cut it, click a node to crash it, and the protocols have to cope — exactly as
              they must in the real world.
            </p>
          </div>
          <div>
            <h4>Time travel + invariants</h4>
            <p>
              The kernel serializes its entire state after every step into a history ring, so the
              scrubber can jump to any past instant exactly. Safety invariants are recomputed on every
              frame, so a violation is caught the moment it happens.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
