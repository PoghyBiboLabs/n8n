<script setup lang="ts">
import { N8nIcon, N8nIconButton, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useStorage } from '@vueuse/core';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue';

const METRICS_URL = 'http://127.0.0.1:7412/v1/metrics';
const STORAGE_KEY = 'N8N_POBIFY_RESOURCE_OVERLAY';
const HISTORY_LIMIT = 60;

interface ResourceValues {
	cpuPercent: number;
	memoryUsedBytes: number;
	memoryTotalBytes: number;
}

interface ResourceSample {
	timestamp: number;
	host: ResourceValues;
	n8n: ResourceValues;
	n8nAvailable: boolean;
	hostDisk: { usedBytes: number; totalBytes: number };
	hostNetwork: { sentBytes: number; receivedBytes: number };
	hostUptimeSeconds: number;
	n8nDetails: { pids: number; networkIo: string; blockIo: string };
}

interface OverlayState {
	x: number;
	y: number;
	width: number;
	height: number;
	collapsed: boolean;
}

const i18n = useI18n();
const overlay = useTemplateRef<HTMLElement>('overlay');
const state = useStorage<OverlayState>(STORAGE_KEY, {
	x: 16,
	y: 72,
	width: 380,
	height: 360,
	collapsed: false,
});
const history = ref<ResourceSample[]>([]);
const unavailable = ref(false);
let pollTimer: ReturnType<typeof setInterval> | undefined;
let resizeObserver: ResizeObserver | undefined;
let dragOffset = { x: 0, y: 0 };
let dragPointerId: number | undefined;
let pollingStopped = false;

const current = computed(() => history.value.at(-1));
const overlayStyle = computed(() => ({
	left: `${state.value.x}px`,
	top: `${state.value.y}px`,
	width: `${state.value.width}px`,
	...(state.value.collapsed ? {} : { height: `${state.value.height}px` }),
}));

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function numberFrom(record: Record<string, unknown>, keys: string[]): number {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'number' && Number.isFinite(value)) return value;
	}
	return 0;
}

function readResource(value: unknown): ResourceValues {
	if (!isRecord(value)) return { cpuPercent: 0, memoryUsedBytes: 0, memoryTotalBytes: 0 };
	const cpu = isRecord(value.cpu) ? value.cpu : value;
	const memory = isRecord(value.memory) ? value.memory : value;
	return {
		cpuPercent: numberFrom(cpu, [
			'cpuPercent',
			'cpu_percent',
			'cpuUsagePercent',
			'usagePercent',
			'percent',
		]),
		memoryUsedBytes: numberFrom(memory, [
			'memoryUsedBytes',
			'memory_usage_bytes',
			'usedBytes',
			'used_bytes',
			'usage',
			'used',
		]),
		memoryTotalBytes: numberFrom(memory, [
			'memoryTotalBytes',
			'memoryLimitBytes',
			'memory_limit_bytes',
			'totalBytes',
			'total_bytes',
			'limit_bytes',
			'limit',
			'total',
		]),
	};
}

function readN8nContainer(containers: unknown): unknown {
	if (Array.isArray(containers)) {
		return containers.find(
			(container) => isRecord(container) && (container.name === 'n8n' || container.id === 'n8n'),
		);
	}
	return isRecord(containers) ? containers.n8n : undefined;
}

function parseSample(value: unknown): ResourceSample | undefined {
	if (!isRecord(value)) return undefined;
	const root = isRecord(value.data) ? value.data : value;
	const host = isRecord(root.host) ? root.host : root;
	const disk = isRecord(host.disk) ? host.disk : {};
	const network = isRecord(host.network) ? host.network : {};
	const n8n = isRecord(root.n8n) ? root.n8n : readN8nContainer(root.containers ?? root.container);
	const n8nRecord = isRecord(n8n) ? n8n : {};
	return {
		timestamp: typeof root.sampled_at === 'string' ? Date.parse(root.sampled_at) : Date.now(),
		host: readResource(host),
		n8n: readResource(n8n),
		n8nAvailable: n8nRecord.available !== false,
		hostDisk: {
			usedBytes: numberFrom(disk, ['used_bytes', 'usedBytes']),
			totalBytes: numberFrom(disk, ['total_bytes', 'totalBytes']),
		},
		hostNetwork: {
			sentBytes: numberFrom(network, ['bytes_sent', 'sentBytes']),
			receivedBytes: numberFrom(network, ['bytes_received', 'receivedBytes']),
		},
		hostUptimeSeconds: numberFrom(host, ['uptime_seconds', 'uptimeSeconds']),
		n8nDetails: {
			pids: numberFrom(n8nRecord, ['pids']),
			networkIo: typeof n8nRecord.network_io === 'string' ? n8nRecord.network_io : '-',
			blockIo: typeof n8nRecord.block_io === 'string' ? n8nRecord.block_io : '-',
		},
	};
}

async function pollMetrics() {
	try {
		const response = await window.fetch(METRICS_URL);
		if (!response.ok) throw new Error('Metrics request failed');
		const sample = parseSample(await response.json());
		if (!sample) throw new Error('Metrics response is invalid');
		history.value = [...history.value, sample].slice(-HISTORY_LIMIT);
		unavailable.value = false;
	} catch {
		unavailable.value = true;
	}
}

async function pollAndSchedule() {
	await pollMetrics();
	if (!pollingStopped) pollTimer = setTimeout(pollAndSchedule, 1000);
}

function formatPercent(value: number): string {
	return `${value.toFixed(1)}%`;
}

function formatMemory(resource: ResourceValues): string {
	const gib = 1024 ** 3;
	return `${(resource.memoryUsedBytes / gib).toFixed(1)} GB / ${(resource.memoryTotalBytes / gib).toFixed(1)} GB`;
}

function formatBytes(value: number): string {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let amount = value;
	let unit = 0;
	while (amount >= 1024 && unit < units.length - 1) {
		amount /= 1024;
		unit++;
	}
	return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatUptime(seconds: number): string {
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3600);
	return `${days}d ${hours}h`;
}

function networkRate(key: keyof ResourceSample['hostNetwork']): string {
	const latest = history.value.at(-1);
	const previous = history.value.at(-2);
	if (!latest || !previous) return '0 B/s';
	const elapsedSeconds = Math.max((latest.timestamp - previous.timestamp) / 1000, 0.001);
	return `${formatBytes(Math.max(latest.hostNetwork[key] - previous.hostNetwork[key], 0) / elapsedSeconds)}/s`;
}

function memoryPercent(resource: ResourceValues): number {
	return resource.memoryTotalBytes > 0
		? (resource.memoryUsedBytes / resource.memoryTotalBytes) * 100
		: 0;
}

function chartPoints(selector: (sample: ResourceSample) => number): string {
	if (history.value.length === 0) return '';
	const denominator = Math.max(history.value.length - 1, 1);
	return history.value
		.map((sample, index) => {
			const x = (index / denominator) * 100;
			const y = 100 - Math.min(Math.max(selector(sample), 0), 100);
			return `${x},${y}`;
		})
		.join(' ');
}

function startDrag(event: PointerEvent) {
	if (event.button !== 0) return;
	event.preventDefault();
	dragOffset = { x: event.clientX - state.value.x, y: event.clientY - state.value.y };
	dragPointerId = event.pointerId;
	document.addEventListener('pointermove', drag);
	document.addEventListener('pointerup', stopDrag);
	document.addEventListener('pointercancel', stopDrag);
}

function drag(event: PointerEvent) {
	if (event.pointerId !== dragPointerId) return;
	const maxX = Math.max(0, window.innerWidth - (overlay.value?.offsetWidth ?? 0));
	const maxY = Math.max(0, window.innerHeight - (overlay.value?.offsetHeight ?? 0));
	state.value.x = Math.min(Math.max(0, event.clientX - dragOffset.x), maxX);
	state.value.y = Math.min(Math.max(0, event.clientY - dragOffset.y), maxY);
}

function stopDrag(event?: PointerEvent) {
	if (event && event.pointerId !== dragPointerId) return;
	dragPointerId = undefined;
	document.removeEventListener('pointermove', drag);
	document.removeEventListener('pointerup', stopDrag);
	document.removeEventListener('pointercancel', stopDrag);
}

function clampToViewport() {
	const width = overlay.value?.offsetWidth || Math.min(state.value.width, window.innerWidth);
	const height = overlay.value?.offsetHeight || Math.min(state.value.height, window.innerHeight);
	state.value.x = Math.min(Math.max(0, state.value.x), Math.max(0, window.innerWidth - width));
	state.value.y = Math.min(Math.max(0, state.value.y), Math.max(0, window.innerHeight - height));
}

function moveWithKeyboard(event: KeyboardEvent) {
	const movements: Record<string, readonly [number, number]> = {
		ArrowLeft: [-16, 0],
		ArrowRight: [16, 0],
		ArrowUp: [0, -16],
		ArrowDown: [0, 16],
	};
	const movement = movements[event.key];
	if (!movement) return;
	event.preventDefault();
	state.value.x += movement[0];
	state.value.y += movement[1];
	clampToViewport();
}

function toggleCollapsed() {
	state.value.collapsed = !state.value.collapsed;
	nextTick(clampToViewport).catch(() => undefined);
}

onMounted(() => {
	pollingStopped = false;
	clampToViewport();
	window.addEventListener('resize', clampToViewport);
	pollAndSchedule().catch(() => undefined);
	if (overlay.value && 'ResizeObserver' in window) {
		resizeObserver = new ResizeObserver(([entry]) => {
			if (!entry || state.value.collapsed) return;
			state.value.width = Math.round(
				entry.borderBoxSize?.[0]?.inlineSize ??
					overlay.value?.offsetWidth ??
					entry.contentRect.width,
			);
			state.value.height = Math.round(
				entry.borderBoxSize?.[0]?.blockSize ??
					overlay.value?.offsetHeight ??
					entry.contentRect.height,
			);
			clampToViewport();
		});
		resizeObserver.observe(overlay.value);
	}
});

onBeforeUnmount(() => {
	pollingStopped = true;
	if (pollTimer) clearTimeout(pollTimer);
	resizeObserver?.disconnect();
	window.removeEventListener('resize', clampToViewport);
	stopDrag();
});
</script>

<template>
	<aside
		ref="overlay"
		:class="[$style.overlay, { [$style.collapsed]: state.collapsed }]"
		:style="overlayStyle"
		data-test-id="resource-usage-overlay"
	>
		<header
			:class="$style.header"
			data-test-id="resource-usage-drag-handle"
			tabindex="0"
			:aria-label="i18n.baseText('resourceUsage.move')"
			@pointerdown="startDrag"
			@keydown="moveWithKeyboard"
		>
			<div :class="$style.title">
				<N8nIcon icon="monitor" size="medium" />
				<N8nText bold>{{ i18n.baseText('resourceUsage.title') }}</N8nText>
			</div>
			<N8nIconButton
				:icon="state.collapsed ? 'chevron-down' : 'chevron-up'"
				variant="ghost"
				size="small"
				:aria-label="
					state.collapsed
						? i18n.baseText('resourceUsage.expand')
						: i18n.baseText('resourceUsage.collapse')
				"
				data-test-id="resource-usage-collapse"
				@pointerdown.stop
				@click="toggleCollapsed"
			/>
		</header>

		<div v-if="!state.collapsed" :class="$style.content" data-test-id="resource-usage-content">
			<N8nText v-if="unavailable && !current" size="small" color="text-light">
				{{ i18n.baseText('resourceUsage.unavailable') }}
			</N8nText>
			<N8nText
				v-else-if="unavailable"
				size="small"
				color="warning"
				data-test-id="resource-usage-stale"
			>
				{{ i18n.baseText('resourceUsage.stale') }}
			</N8nText>
			<template v-if="current">
				<section v-for="resource in ['host', 'n8n'] as const" :key="resource" :class="$style.card">
					<N8nText bold size="small">
						{{
							resource === 'host'
								? i18n.baseText('resourceUsage.host')
								: i18n.baseText('resourceUsage.n8n')
						}}
					</N8nText>
					<N8nText
						v-if="resource === 'n8n' && !current.n8nAvailable"
						size="small"
						color="warning"
						data-test-id="resource-usage-n8n-unavailable"
					>
						{{ i18n.baseText('resourceUsage.containerUnavailable') }}
					</N8nText>
					<div :class="$style.metrics">
						<template v-if="resource !== 'n8n' || current.n8nAvailable">
							<div>
								<N8nText size="xsmall" color="text-light">{{
									i18n.baseText('resourceUsage.cpu')
								}}</N8nText>
								<N8nText size="small">{{ formatPercent(current[resource].cpuPercent) }}</N8nText>
							</div>
							<div>
								<N8nText size="xsmall" color="text-light">{{
									i18n.baseText('resourceUsage.memory')
								}}</N8nText>
								<N8nText size="small">{{ formatMemory(current[resource]) }}</N8nText>
							</div>
						</template>
					</div>
					<div v-if="resource === 'host'" :class="$style.details">
						<N8nText size="xsmall">
							{{ i18n.baseText('resourceUsage.disk') }}:
							{{ formatBytes(current.hostDisk.usedBytes) }} /
							{{ formatBytes(current.hostDisk.totalBytes) }}
						</N8nText>
						<N8nText size="xsmall">
							{{ i18n.baseText('resourceUsage.network') }}: ↓ {{ networkRate('receivedBytes') }} ↑
							{{ networkRate('sentBytes') }}
						</N8nText>
						<N8nText size="xsmall">
							{{ i18n.baseText('resourceUsage.uptime') }}:
							{{ formatUptime(current.hostUptimeSeconds) }}
						</N8nText>
					</div>
					<div v-else-if="current.n8nAvailable" :class="$style.details">
						<N8nText size="xsmall">
							{{ i18n.baseText('resourceUsage.processes') }}: {{ current.n8nDetails.pids }}
						</N8nText>
						<N8nText size="xsmall">
							{{ i18n.baseText('resourceUsage.networkIo') }}: {{ current.n8nDetails.networkIo }}
						</N8nText>
						<N8nText size="xsmall">
							{{ i18n.baseText('resourceUsage.blockIo') }}: {{ current.n8nDetails.blockIo }}
						</N8nText>
					</div>
				</section>

				<svg
					:class="$style.chart"
					viewBox="0 0 100 100"
					preserveAspectRatio="none"
					data-test-id="resource-usage-history"
					:data-samples="history.length"
					aria-hidden="true"
				>
					<polyline
						:points="chartPoints((sample) => sample.host.cpuPercent)"
						:class="$style.hostCpu"
					/>
					<polyline
						:points="chartPoints((sample) => memoryPercent(sample.host))"
						:class="$style.hostMemory"
					/>
					<polyline
						:points="chartPoints((sample) => sample.n8n.cpuPercent)"
						:class="$style.n8nCpu"
					/>
					<polyline
						:points="chartPoints((sample) => memoryPercent(sample.n8n))"
						:class="$style.n8nMemory"
					/>
				</svg>
				<div :class="$style.legend">
					<span
						><i :class="$style.hostCpuKey"></i>{{ i18n.baseText('resourceUsage.hostCpu') }}</span
					>
					<span
						><i :class="$style.hostMemoryKey"></i
						>{{ i18n.baseText('resourceUsage.hostMemory') }}</span
					>
					<span><i :class="$style.n8nCpuKey"></i>{{ i18n.baseText('resourceUsage.n8nCpu') }}</span>
					<span
						><i :class="$style.n8nMemoryKey"></i
						>{{ i18n.baseText('resourceUsage.n8nMemory') }}</span
					>
				</div>
			</template>
		</div>
	</aside>
</template>

<style lang="scss" module>
.overlay {
	position: fixed;
	z-index: 299;
	display: flex;
	flex-direction: column;
	min-width: min(20rem, calc(100vw - var(--spacing--lg)));
	min-height: 16rem;
	max-width: calc(100vw - var(--spacing--lg));
	max-height: calc(100vh - var(--spacing--lg));
	resize: both;
	overflow: hidden;
	border: var(--border);
	border-radius: var(--radius--xl);
	background: var(--color--background--light-3);
	box-shadow: var(--box-shadow--light);
}

.collapsed {
	min-height: 0;
	height: auto;
	resize: none;
}

.header,
.title,
.metrics {
	display: flex;
	align-items: center;
}

.header {
	justify-content: space-between;
	flex-shrink: 0;
	padding: var(--spacing--2xs) var(--spacing--xs);
	border-bottom: var(--border);
	cursor: grab;
	touch-action: none;
}

.title {
	gap: var(--spacing--3xs);
}

.content {
	display: flex;
	flex: 1;
	flex-direction: column;
	gap: var(--spacing--xs);
	padding: var(--spacing--xs);
	overflow: auto;
}

.card {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
	padding: var(--spacing--2xs);
	border: var(--border);
	border-radius: var(--radius--lg);
}

.metrics {
	justify-content: space-between;
	gap: var(--spacing--sm);
}

.metrics > div {
	display: flex;
	flex-direction: column;
}

.details {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
	gap: var(--spacing--3xs);
}

.chart {
	flex: 1;
	min-height: 5rem;
	width: 100%;
	border-top: var(--border);
}

.chart polyline {
	fill: none;
	stroke-width: 1.5;
	vector-effect: non-scaling-stroke;
}

.legend {
	display: flex;
	flex-wrap: wrap;
	gap: var(--spacing--3xs) var(--spacing--xs);
	font-size: var(--font-size--3xs);
}

.legend span {
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--4xs);
}

.legend i {
	display: inline-block;
	width: var(--spacing--xs);
	height: 2px;
}

.hostCpuKey {
	background: var(--color--primary);
}

.hostMemoryKey {
	background: var(--color--success);
}

.n8nCpuKey {
	background: var(--color--warning);
}

.n8nMemoryKey {
	background: var(--color--text--light);
}

.hostCpu {
	stroke: var(--color--primary);
}
.hostMemory {
	stroke: var(--color--success);
}
.n8nCpu {
	stroke: var(--color--warning);
}
.n8nMemory {
	stroke: var(--color--text--light);
}
</style>
