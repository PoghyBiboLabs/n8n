<script setup lang="ts">
import MainHeader from '@/app/components/MainHeader/MainHeader.vue';
import ResourceUsageOverlay from './ResourceUsageOverlay.vue';
</script>

<template>
	<div :class="$style.root">
		<MainHeader />
		<ResourceUsageOverlay />
	</div>
</template>

<style lang="scss" module>
.root {
	display: contents;
}
</style>
