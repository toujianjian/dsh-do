import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { LoopController } from '../lib/types/controller.js'
import {
	TUI_COMMANDS_SERVICE,
	TUI_LOOP_COMMAND_NAME,
	buildTuiLoopCommand,
	installTuiCommand,
	isTuiCommandRegistry,
} from '../lib/types/tui.js'

const logger = { info() {}, warn() {} }
const controller = () => new LoopController(undefined, logger)
const budget = () => 7

/** A stand-in for the TUI's `SlashCommandRegistry`, matching its real surface. */
function fakeRegistry() {
	const commands = new Map()
	return {
		registered: commands,
		register(command) {
			if (command.name === '' || command.name.includes(' ')) throw new Error(`invalid slash command name: ${JSON.stringify(command.name)}`)
			commands.set(command.name, command)
		},
		unregister(name) { commands.delete(name) },
		list() { return [...commands.values()] },
	}
}

test('isTuiCommandRegistry accepts the real registry surface and rejects lookalikes', () => {
	assert.equal(isTuiCommandRegistry(fakeRegistry()), true)
	assert.equal(isTuiCommandRegistry(undefined), false)
	assert.equal(isTuiCommandRegistry(null), false)
	assert.equal(isTuiCommandRegistry('tui.commands'), false)
	assert.equal(isTuiCommandRegistry({}), false)
	// A registry must be able to undo its own registration, so `unregister` is
	// part of the shape, not an optional nicety.
	assert.equal(isTuiCommandRegistry({ register() {} }), false)
	assert.equal(isTuiCommandRegistry({ unregister() {} }), false)
})

test('the TUI command drives the same controller as the tools', () => {
	const loops = controller()
	const echoed = []
	const command = buildTuiLoopCommand({
		controller: loops,
		defaultMaxRounds: budget,
		findAgent: () => undefined,
	})
	assert.equal(command.name, 'loop')
	assert.equal(command.name, TUI_LOOP_COMMAND_NAME)
	assert.equal(typeof command.description, 'string')
	assert.match(command.argsHint, /pause/)

	command.run({ text: '5m ship it', echo: (line) => echoed.push(line), sessionId: 's' })
	assert.match(echoed.at(-1), /Loop started/)
	assert.equal(loops.get('s').objective, 'ship it')
	assert.equal(loops.get('s').intervalMs, 300_000)
	assert.equal(loops.get('s').maxRounds, 7)

	command.run({ text: '', echo: (line) => echoed.push(line), sessionId: 's' })
	assert.match(echoed.at(-1), /Status: active/)
	assert.match(echoed.at(-1), /Cadence: every 5m/)
})

test('the TUI command reports a refusal as a refusal and survives no session', () => {
	const loops = controller()
	const echoed = []
	const command = buildTuiLoopCommand({ controller: loops, defaultMaxRounds: budget, findAgent: () => undefined })

	// No session: a loop is per-session, so this is a message rather than a throw.
	command.run({ text: 'go', echo: (line) => echoed.push(line), sessionId: null })
	assert.match(echoed.at(-1), /^⚠ 当前无会话/)

	command.run({ text: 'first', echo: (line) => echoed.push(line), sessionId: 's' })
	// A second start is refused, and the refusal is marked as an error in the UI.
	command.run({ text: 'second', echo: (line) => echoed.push(line), sessionId: 's' })
	assert.match(echoed.at(-1), /^⚠ /)
	assert.match(echoed.at(-1), /already active/)
	assert.equal(loops.get('s').objective, 'first')
})

test('the TUI command counts rounds from the live agent when one is attached', () => {
	const loops = controller()
	const echoed = []
	const start = buildTuiLoopCommand({ controller: loops, defaultMaxRounds: budget, findAgent: () => undefined })
	start.run({ text: 'go', echo: (line) => echoed.push(line), sessionId: 's' })

	// `effectiveRounds` prefers the durable log: an admitted round is one stamped
	// with this loop's id and a round number, exactly as the driver writes it.
	const events = [{ type: 'user/message', data: { source: { kind: 'loop', loopId: loops.get('s').id, round: 1 } } }]
	const withAgent = buildTuiLoopCommand({
		controller: loops,
		defaultMaxRounds: budget,
		findAgent: () => ({ session: { id: 's', events } }),
	})
	withAgent.run({ text: '', echo: (line) => echoed.push(line), sessionId: 's' })
	assert.match(echoed.at(-1), /Rounds: 1\/7/)

	// A round belonging to a different loop must not be counted.
	events[0].data.source.loopId = 'someone-elses-loop'
	withAgent.run({ text: '', echo: (line) => echoed.push(line), sessionId: 's' })
	assert.match(echoed.at(-1), /Rounds: 0\/7/)
})

test('installTuiCommand waits for the TUI registry and registers /loop', async () => {
	const ctx = new Context()
	// In the plugin `agents` is a hard inject, so it is always present by the time
	// the TUI command can run; a bare Context has to be told about it.
	ctx.provide('agents', { get: () => undefined })
	const loops = controller()
	installTuiCommand(ctx, loops, budget)
	await Promise.resolve()

	// Under web/headless the service never appears, so nothing is registered and
	// nothing fails.
	const registry = fakeRegistry()
	assert.equal(registry.list().length, 0)

	// The TUI app publishes its registry during construction; the pending
	// injection activates then.
	ctx.provide(TUI_COMMANDS_SERVICE, registry)
	await Promise.resolve()
	await Promise.resolve()

	assert.equal(registry.list().length, 1)
	const registered = registry.registered.get(TUI_LOOP_COMMAND_NAME)
	assert.equal(registered.name, 'loop')

	// It drives the live loop exactly like the DSH command registry does.
	registered.run({ text: 'audit the parser', echo: () => {}, sessionId: 'live' })
	assert.equal(loops.get('live').objective, 'audit the parser')

	// Teardown removes it, so a disposed plugin leaves no ghost command.
	await ctx.fiber.dispose()
	assert.equal(registry.list().length, 0)
})

test('installTuiCommand refuses a service that is not a slash-command registry', async () => {
	const ctx = new Context()
	const warnings = []
	ctx.logger.warn = (message) => warnings.push(message)
	installTuiCommand(ctx, controller(), budget)
	await Promise.resolve()

	// A lookalike service must not break the plugin; it is reported and skipped.
	ctx.provide(TUI_COMMANDS_SERVICE, { not: 'a registry' })
	await Promise.resolve()
	await Promise.resolve()

	assert.equal(warnings.length, 1)
	assert.match(warnings[0], /is not a slash-command registry/)
	await ctx.fiber.dispose()
})
