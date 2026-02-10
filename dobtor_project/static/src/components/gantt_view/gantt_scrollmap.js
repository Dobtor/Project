/** @odoo-module **/

import { Component, useState, useRef, onMounted, onWillUnmount, onPatched } from "@odoo/owl";

/**
 * Mini-map scroll indicator for the Gantt timeline.
 * Shows a small overview of the full timeline with a draggable viewport indicator.
 *
 * Props:
 *   timelineWidth: total width of the timeline data in px
 *   viewportWidth: visible width of the timeline viewport in px
 *   scrollLeft: current horizontal scroll position
 *   rowCount: total number of visible rows
 *   viewportHeight: visible height of the timeline viewport
 *   scrollTop: current vertical scroll position
 *   totalHeight: total height of the timeline data
 *   todayPosition: pixel position of today marker (or null)
 *   onScroll: (scrollLeft, scrollTop) => void
 */
export class GanttScrollMap extends Component {
    static template = "dobtor_project.GanttScrollMap";

    static props = {
        timelineWidth: Number,
        viewportWidth: Number,
        scrollLeft: Number,
        rowCount: Number,
        viewportHeight: Number,
        scrollTop: Number,
        totalHeight: Number,
        todayPosition: { optional: true },
        onScroll: Function,
    };

    setup() {
        this.canvasRef = useRef("scrollMapCanvas");
        this.state = useState({
            isDragging: false,
        });

        this.MAP_WIDTH = 200;
        this.MAP_HEIGHT = 40;

        this._onMouseDown = this._onMouseDown.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);

        onMounted(() => {
            this._draw();
        });

        onPatched(() => {
            this._draw();
        });

        onWillUnmount(() => {
            document.removeEventListener("mousemove", this._onMouseMove);
            document.removeEventListener("mouseup", this._onMouseUp);
        });
    }

    _draw() {
        const canvas = this.canvasRef.el;
        if (!canvas) return;

        const ctx = canvas.getContext("2d");
        const w = this.MAP_WIDTH;
        const h = this.MAP_HEIGHT;

        canvas.width = w;
        canvas.height = h;

        // Clear
        ctx.clearRect(0, 0, w, h);

        // Background
        const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        ctx.fillStyle = isDark ? "rgba(28, 28, 30, 0.9)" : "rgba(242, 242, 247, 0.9)";
        ctx.fillRect(0, 0, w, h);

        const { timelineWidth, viewportWidth, scrollLeft, totalHeight, viewportHeight, scrollTop, todayPosition } = this.props;

        if (timelineWidth <= 0) return;

        const scaleX = w / timelineWidth;
        const scaleY = h / Math.max(totalHeight, viewportHeight);

        // Today marker
        if (todayPosition != null) {
            const tx = todayPosition * scaleX;
            ctx.strokeStyle = "rgba(255, 59, 48, 0.6)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(tx, 0);
            ctx.lineTo(tx, h);
            ctx.stroke();
        }

        // Viewport rectangle
        const vpX = scrollLeft * scaleX;
        const vpW = Math.max(viewportWidth * scaleX, 4);
        const vpY = scrollTop * scaleY;
        const vpH = Math.max(viewportHeight * scaleY, 4);

        ctx.strokeStyle = isDark ? "rgba(10, 132, 255, 0.8)" : "rgba(0, 122, 255, 0.8)";
        ctx.lineWidth = 1.5;
        ctx.fillStyle = isDark ? "rgba(10, 132, 255, 0.15)" : "rgba(0, 122, 255, 0.12)";
        ctx.fillRect(vpX, vpY, vpW, vpH);
        ctx.strokeRect(vpX, vpY, vpW, vpH);
    }

    _onMouseDown(ev) {
        ev.preventDefault();
        this.state.isDragging = true;
        this._scrollTo(ev);

        document.addEventListener("mousemove", this._onMouseMove);
        document.addEventListener("mouseup", this._onMouseUp);
    }

    _onMouseMove(ev) {
        if (!this.state.isDragging) return;
        this._scrollTo(ev);
    }

    _onMouseUp() {
        this.state.isDragging = false;
        document.removeEventListener("mousemove", this._onMouseMove);
        document.removeEventListener("mouseup", this._onMouseUp);
    }

    _scrollTo(ev) {
        const canvas = this.canvasRef.el;
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();
        const relX = ev.clientX - rect.left;
        const relY = ev.clientY - rect.top;

        const { timelineWidth, viewportWidth, totalHeight, viewportHeight } = this.props;
        const scaleX = this.MAP_WIDTH / timelineWidth;
        const scaleY = this.MAP_HEIGHT / Math.max(totalHeight, viewportHeight);

        // Center viewport on click position
        const newScrollLeft = (relX / scaleX) - (viewportWidth / 2);
        const newScrollTop = (relY / scaleY) - (viewportHeight / 2);

        const clampedLeft = Math.max(0, Math.min(newScrollLeft, timelineWidth - viewportWidth));
        const clampedTop = Math.max(0, Math.min(newScrollTop, totalHeight - viewportHeight));

        this.props.onScroll(clampedLeft, clampedTop);
    }
}
