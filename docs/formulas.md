# The formulas

Every equation the simulation evaluates, in the order water moves through it:
a storm makes rain, rain lands on a street, the street sheds it to its
neighbours, to a grate, into the ground, or over a bank, and the pipe below
carries what it took.

This is the written target for anything meant to replace or reproduce the
model. It is generated from the source, not from memory - each heading links
to the lines that implement it.

Units are SI throughout - metres, seconds, m³, m³/s - except rainfall
intensity, which is carried in mm/hour because that is how rain is quoted.
Conversion happens at the point of use (`/3.6e6` turns mm/h into m/s).

---

## A. Storm - where rain comes from

### A1. The rain cell

`src/sim/storm.js:140-153`

A Gaussian with a hard edge:

```
I(d) = Imax · exp( −d² / (2σ²) )      for d < R_rain
I(d) = 0                              for d ≥ R_rain
```

`d` is the distance from the cell centre, `σ` sets how fast rain falls off,
and `R_rain` truncates the exponential tail so a single cell does not drizzle
over the whole province. The defaults put `R_rain` at 3σ.

The cloud radius `R_cloud` is larger than `R_rain` and is visual only: it
answers "is this point under cloud" and never enters `I`. Being under cloud
does not mean rain is reaching the ground.

### A2. Superposition

`src/sim/storm.js:119-127`

Cells add, with no cap:

```
I_total(x, y) = Σ_storms I_s(x, y)
```

Two overlapping cells reinforce, which is the point.

### A3. Advection

`src/sim/storm.js:102-113`

Cells translate; they do not deform, split or merge.

```
x ← x + v_east · dt
y ← y + v_north · dt
age ← age + dt
```

A cell is dropped once `age ≥ lifetime`.

### A4. Steering wind

`src/hydro/hydraulics.js:237-246`

Meteorological direction is where the wind comes *from*, so a cell moves the
opposite way:

```
θ       = dir_from + 180°
v_east  = f · U · sin θ
v_north = f · U · cos θ
```

`f` scales the reported wind to the speed that actually steers a cell:
**0.75** against the 850 hPa wind, **1.5** against the 10 m wind (mid-level
wind runs about half again as fast as the surface wind).

### A5. Texture

`src/sim/rainfallGrid.js:352-386`

Smooth value noise on a coarse lattice, applied *after* the Gaussian so the
Gaussian stays dominant, and only to storms - a published forecast is not
ours to add texture to.

```
I ← I · (1 + (2·noise − 1) · A)

noise    = bilinear over an 8-cell lattice of hash(x, y)
smoothing= t²(3 − 2t)
drift    = elapsed / 600      (the field crawls with time)
```

Per-cell randomness was rejected: it reads as static and destroys the smooth
falloff the Gaussian exists to provide.

### A6. Grid integration

`src/sim/rainfallGrid.js:209-241`

Each cell accumulates depth, and carries a surface store that decays as water
drains and soaks away. The store obeys

```
ds/dt = I/3600 − s/τ
```

which is integrated in **closed form**, so one call over a whole forecast hour
lands on exactly the same water as sixty one-minute calls:

```
accumulation += I · dt/3600                            [mm]
s ← s · e^(−dt/τ)  +  I · (τ/3600) · (1 − e^(−dt/τ))
```

with `τ = 900 s`. Below 0.02 mm the store snaps to zero.

### A7. Forecast rain

`src/sim/forecastRain.js:126-170`

An hourly forecast bucket is held constant across its hour, `I = mm / 1 h`,
and resampled from the coarse forecast lattice onto the rain grid by bilinear
weights:

```
w_j = (tx or 1−tx) · (ty or 1−ty)        over the 4 surrounding cells
I   = Σ w_j · I_j / Σ w_j
```

Corners the lattice lacks (a thinned grid, its outer edge) drop out and the
remaining weights renormalise; a cell with no forecast cell around it reads 0.

Nearest-cell sampling was tried and drew a cliff along every forecast cell
edge - one side of a street raining, the other dry - which is the sampling,
not the weather.

### A8. Tide

`src/hydro/hydraulics.js:203-217`

The stand-in when the live sea-level forecast cannot be fetched: a sum of
cosines, one per astronomical constituent.

```
η(t) = η̄ + Σ A_i · cos( 2π·t_h / T_i − φ_i )
```

| constituent | period (h) | amplitude (m) | phase |
| --- | --- | --- | --- |
| K1 | 23.9345 | 0.55 | 40° |
| O1 | 25.8193 | 0.35 | 10° |
| M2 | 12.4206 | 0.25 | 0° |
| S2 | 12.0 | 0.10 | 0° |

Together these give the mixed, mainly diurnal tide of about 1.5-2 m range
that the Gulf of Thailand does at Pattaya. The phases are anchored to the Unix
epoch and are arbitrary: **this is the shape of the tide, not today's
timetable.** The live forecast replaces it whenever it can be reached.

---

## B. Street runoff

### B1. What one junction stands for

`src/hydro/roadFlow.js:300-320`

```
A_patch  = width × Σ(½ · length of each street at the junction)
           (falls back to 120 m² where the survey gave no width)
A_flood  = max( A_patch , L_half · W_catch )        W_catch = 60 m
C_runoff = max( 1 , C · L_half · W_catch / A_patch )    C = 0.9
V_curb   = A_patch · d_curb                          d_curb = 0.15 m
```

`A_patch` is the carriageway the junction owns. `A_flood` is the plain the
water spreads over once it tops the curb. `C_runoff` is how much more rain the
junction collects than lands on its own asphalt - the yards and roofs that
drain to the street - and is never less than 1.

This used to be one number for all 266,305 junctions, which made a 19 m
boulevard hold water as deep as a 2 m lane.

### B2. Rain onto a junction

`src/hydro/roadFlow.js:820-826`

Spent per substep, not per step:

```
ΔV = I · (dt_sub / 3.6e6) · A_patch · C_runoff        [m³]
```

### B3. Stage-storage

`src/hydro/roadFlow.js:449-452`

Two stages - the gutter first, the verge after:

```
d = V / A_patch                               V ≤ V_curb
d = d_curb + (V − V_curb) / A_flood           V > V_curb
```

### B4. Transfer between junctions

`src/hydro/roadFlow.js:906-948`

Manning's equation on the **water-surface** slope, not the bed slope. That is
what makes a full downstream street back water up an upstream one, and it is
the whole reason the model can show a flood spreading against the ground
gradient.

```
H  = (z_a + d_a) − (z_b + d_b)         the higher surface is the source
v  = (1/n) · d^(2/3) · √(H / L)        n = 0.015, and v is capped at 3 m/s
φ  = min( 1 , v · dt_sub / L )
Δd = min( d · φ , 0.25 · H )
ΔV = Δd · A_patch(source)
```

The `0.25·H` cap stops a transfer past the level the two surfaces would
equalise at. A quarter, rather than a half, leaves room for a four-way
junction sending in every direction at once without overshooting into a
ping-pong between substeps.

### B5. Mass conservation

`src/hydro/roadFlow.js:1031-1055`

Four phases per substep, so the order junctions are visited in cannot change
the answer:

```
1. propose a transfer on every edge, from the frozen state
2. scale[n] = min( 1 , V[n] / Σ proposed_out[n] )
3. land every transfer at once:   moved = |flow| · scale[src]
4. apply, infiltrate, drain, snap dry
```

Phase 2 is what guarantees a junction never sends more water than it holds.

### B6. Substeps

`src/hydro/roadFlow.js:795`

```
N      = clamp( ⌈ v_max · dt / 15 m ⌉ , 1 , 20 )
dt_sub = dt / N
```

Fixed, not adaptive. Sizing substeps by the fastest water actually moving was
tried twice and does not work: across a whole province something is always
running at the 3 m/s cap - even under 2 mm/h, where runoff concentrates on a
steep street - so the adaptive length never rises and the model got *slower*.
Forcing it up with a floor made it cheap but simply made the coarse answer
universal: the deepest water read 238 cm where a 5 s run said 127 cm.

With the rule above, a sweep of step sizes from 5 s to 300 s agrees to within
a few per cent.

### B7. Infiltration

`src/hydro/roadFlow.js:1093-1101`, `src/hydro/hydraulics.js:188-193`

Horton's curve. Dry ground soaks water up fast, then settles to a steady rate
as it saturates.

```
f(t)   = fc + (f0 − fc) · e^(−k · (t − t_wet))
soaked = f · p · A · dt_sub
```

| | |
| --- | --- |
| `f0` | 60 mm/h - the dry rate |
| `fc` | 12 mm/h - saturated |
| `k` | 2 per hour - how fast it decays |
| `p` | pervious fraction: 0.05 on the carriageway, 0.35 on the flood plain |
| `A` | `A_patch` below the curb, `A_flood` above it |

`t_wet` is per junction, set when it first goes wet and cleared when it dries.
Snapshots carry it, so a run continued from a snapshot soaks at the same rate
as one played straight through.

### B8. The generic drain

`src/hydro/roadFlow.js:1108-1114`

A capacity, not a proportion, and applied **only where no surveyed inlet
exists** - the surveyed grates run their own equation above.

```
drained = (150 mm/h / 3.6e6) · A · dt_sub
```

### B9. Inlet capture

`src/hydro/hydraulics.js:168-175`, inlined at `src/hydro/roadFlow.js:837-847`

A grated inlet takes water two ways. With a shallow sheet running over it, it
behaves as a **weir** along its perimeter; once submerged it behaves as an
**orifice** through its open area. The lower of the two is what it passes.

```
Q_weir    = 1.66 · P · d^1.5
Q_orifice = 0.67 · A_open · √(2 g d)
Q         = min( Q_weir , Q_orifice ) · (1 − clog)          clog = 0.5

accepted  = min( Q · dt_sub , V_street , room in the manhole below )
```

That last term matters as much as the equation: a surcharged manhole refuses
the grate above it, and the street stays wet. That is how a full trunk shows
itself on the surface.

Capture is taken **per substep**. Taken once for a whole long step, a grate
captured at the depth the step began with, which over five minutes is a
different amount of water.

### B10. Outfalls

`src/hydro/roadFlow.js:955-1025`

A junction discharges if it is a dead end, **or** within 60 m of the surveyed
shoreline, **or** within 40 m of open water - a khlong, river, lake or
reservoir. It leaves over a nominal 20 m edge.

**Sea, draining.** The tide is the receiving level, so the higher the tide the
less head there is, until a drowned outfall stops entirely:

```
z_recv = max( η , z − 0.5 )
H      = z + d − z_recv
v      = (1/n) · d^(2/3) · √(H / 20)          capped at 0.25·H of transfer
```

**Sea, drowned.** When the sea stands above the street water, it flows the
other way, onto the street:

```
H     = η − z − d
d_sea = η − z
v     = (1/n) · d_sea^(2/3) · √(H / 20)       capped at 0.25·H
```

**Free and canal.** The far side is always lower:

```
v = (1/n) · d^(2/3) · √( 0.0005 + d/20 )
```

### B11. Thresholds

```
MIN_FLOW_DEPTH = 5e-4 m           below this it is a film, not flow
SNAP_DRY       = 1e-4 · A_patch   below this the volume is zeroed
```

The snapped volume is booked as `driedFilm`, so the water balance still
closes.

---

## C. The pipe network

### C1. Cross-sections

`src/hydro/hydraulics.js:23-71`

Manning needs the flow area `A` and the hydraulic radius `R = A/P`, both of
which depend on how deep the water in the conduit is.

**Circular**, diameter `D` running `y` deep:

```
θ = 2 · arccos( 1 − 2y/D )
A = (D²/8)(θ − sin θ)
P = D θ / 2
R = A / P
T = D · sin(θ/2)
```

Running full, `A = πD²/4` and `R = D/4`.

**Box**, `W` wide and `H` high:

```
A = W · y
P = W + 2y        part full
P = 2(W + H)      full
```

### C2. Manhole storage and head

`src/hydro/pipeNetwork.js:139-159`, `219-224`

```
A_low = A_shaft + Σ_conduits ( 0.5 · A_full · L / H )
```

`A_low` is the plan area below the crown - the shaft plus half of every pipe
meeting the node. Above the crown only the shaft is left, which is why a
surcharging node fills so much faster than it filled before.

```
h = invert + V / A_low                              V ≤ V_low
h = invert + d_crown + (V − V_low) / A_shaft        surcharged
```

### C3. Conduit flow

`src/hydro/pipeNetwork.js:490-506`

Manning on the hydraulic grade line:

```
S  = (h_src − h_dst) / L
y  = min( h_src − invert_src , H )
Q  = A(y) · (1/n) · R(y)^(2/3) · √S        capped at Q ≤ 4 · A(y)
ΔV = min( Q · dt_sub , 0.25 · V_equalise )
```

where `V_equalise` is the volume that would level two connected tanks:

```
V_equalise = H · A_src · A_dst / (A_src + A_dst)
```

Same quarter-of-the-way rule as the streets, for the same reason.

### C4. Boundaries

`src/hydro/pipeNetwork.js:525-560`

A nominal 20 m conduit, sized to the largest pipe arriving at the node, runs
from the outfall to its receiving water.

```
sea:  z_recv = η        when η > invert − 0.3      (flows both ways)
      z_recv = invert − 0.3    otherwise
free: z_recv = invert − 0.3
```

### C5. Pumps

`src/hydro/hydraulics.js:225-228`, inlined at `src/hydro/pipeNetwork.js:610-624`

A station starts when its sump fills past a start level and stops below a stop
level. The gap between the two is what stops it chattering on and off every
substep.

```
d       = V / A_low
running ← running ? (d > 0.1) : (d ≥ 0.5)
lifted  = min( V , Q_rated · dt_sub )
```

`Q_rated` is per station where the city plan gives it, and 1.0 m³/s otherwise.

### C6. Surcharge and spill

`src/hydro/pipeNetwork.js:626-633`

Anything standing above `V_full` - the volume at the lid - leaves the pipe:

```
excess = V − V_full
V ← V_full
```

The excess goes straight back onto the street above through `addWater`, ready
for the next street substep. A manhole that cannot hold its water pushes it
into the road, which is what a blown manhole cover looks like.

### C7. Substeps, and the two clocks

`src/hydro/pipeNetwork.js:433`, `src/hydro/roadFlow.js:1145-1152`

```
N = clamp( ⌈ v_max · dt / L_min ⌉ , 1 , 30 )        L_min floored at 20 m
```

The streets step the drains from **inside** their own substep loop, every 60
seconds of simulated time, and always flush on the last pass so the two clocks
agree at the end of every step.

Stepped once per outer step instead, a manhole that filled in the first
substep refused the inlet above it for the rest of that step, and a
five-minute step took a quarter less down the grates than the same rain in
short steps.

---

## D. Parameters

Every one of these is overridable from `.env.local`; see `.env.example` for
the variable names and ranges.

| | default | |
| --- | --- | --- |
| street Manning `n` | 0.015 | asphalt |
| pipe Manning `n` | from the survey | concrete ~0.013 |
| max street velocity | 3 m/s | |
| max pipe velocity | 4 m/s | |
| curb depth | 0.15 m | the stage-storage break |
| street patch area | 120 m² | fallback where no surveyed width |
| catchment width | 60 m | the corridor a street collects from |
| runoff coefficient | 0.9 | |
| Horton `f0` / `fc` / `k` | 60 / 12 mm/h, 2 per hour | |
| pervious fraction, street / verge | 0.05 / 0.35 | |
| inlet clogging | 0.5 | leaves and litter |
| generic drain | 150 mm/h | where no surveyed inlet |
| pump start / stop depth | 0.5 / 0.1 m | |
| pump rated flow | per station, else 1.0 m³/s | |
| sea outfall reach | 60 m | from the surveyed shoreline |
| open-water outfall reach | 40 m | khlong, river, lake, reservoir |
| rain surface decay `τ` | 900 s | |

---

## E. What is deliberately not modelled

Worth stating plainly, because it is what separates this from a full
hydrodynamic package, and it is where any comparison should start.

**No momentum.** Every flow equation here is diffusive-wave: the water-surface
slope drives it, and inertia never appears. Backwater is captured; a
travelling flood wave's acceleration is not. On a flat coastal grid this is a
defensible simplification, and it is what most 2D urban flood models do. It is
weakest on the steep streets off Khao Noi and Phratamnak, where the 3 m/s
velocity cap is also doing work it should not have to.

**No pressurised pipe flow.** Surcharge is modelled as storage up the shaft,
which spills at the lid. That gets the volume right and the timing
approximate. A pressure wave propagating upstream through a full trunk - what
a Preissmann slot buys you - is not represented, so a node several hundred
metres away surcharges later here than it would in reality.

**No receiving-water storage.** The sea, the khlongs, the lakes and the
retention ponds are infinite sinks: they accept whatever reaches them and
never fill, never back up, never overflow into each other. The city's own
flood plan documents khlongs overflowing into one another, and the retention
pond holds a finite 100,000 m³, so this is the largest single gap in the
model.

**No groundwater, evaporation, or long-term continuity.** Infiltrated water
leaves the model. Over a three-hour convective storm this is negligible; over
a season it is not.

**No water quality, no control rules, no LID.** Out of scope.
