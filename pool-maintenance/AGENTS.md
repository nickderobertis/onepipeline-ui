# Pool maintenance measurement

The measurement must own its build tree: release-budget Nx tasks run beside
other builds, and neither their new artifacts nor their superseded ones belong
to its workload. Keep the private tree warm between measurements; the untimed
backlog pass bounds it before the steady-state pass.

Run the declared maintenance recipe from the repository root, where the
justfile resolves manifest-derived variables, passing the private target as
its argument. Ordinary maintenance keeps the default checkout target.
