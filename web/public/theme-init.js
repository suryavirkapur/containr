try {
	var t = localStorage.getItem("containr-theme") || "dark";
	var dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
	document.documentElement.classList.toggle("dark", dark);
} catch (e) {}
