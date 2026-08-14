/*  Global class for simulating the movement of particles through a vector
    field — adapted for DANISH SEA/LAKE CURRENTS instead of wind.

    Origin/credit: this is a lightly modified copy of windy.js from
    https://github.com/danwild/wind-js-leaflet (MIT), which itself credits
    https://github.com/cambecc/earth for the original algorithm. Vendored
    locally (rather than loaded from a CDN) to match this repo's existing
    self-hosting policy for third-party map assets (see TILE_SERVER_URL's
    filhoved in dansk-overloeb-kort.html for the same reasoning re. tiles).

    Changes from upstream:
      - Tuned VELOCITY_SCALE / PARTICLE_LINE_WIDTH / PARTICLE_MULTIPLIER /
        MAX_PARTICLE_AGE so the animation reads clearly at Denmark's typical
        zoom levels (bruger-rapport: "almost invisible" med upstream-værdier).
      - MIN/MAX_TEMPERATURE_K recalibrated from wind-chill range (-12..44°C)
        to actual Danish sea/lake surface temperature range (0..22°C), so the
        colour scale actually spans its full blue→red range instead of
        clustering in the middle.
      - createWindBuilder's data() now treats a NaN u-component as "no data"
        (returns null for that grid cell) instead of a numeric [0,0,temp]
        vector — see buildVelocityGridJSON()/applyWaterMaskToVelocityData()
        server/client-side, som maskerer landpunkter til NaN. windy's egen
        interpolate() springer allerede korrekt en hel gittercelle over hvis
        ÉT af de fire hjørnepunkter er null (isValue()-tjekket) — det giver
        markant mindre "lækage" ind over land end en nul-vektor (som stadig
        var en gyldig, tegnelig værdi).

    The takes-a-canvas / start(bounds,width,height,extent) public API is
    unchanged from upstream, so the calling wrapper (buildCurrentsWindyLayer
    in dansk-overloeb-kort.html) is structurally the same as wind-js-leaflet's
    own WindJSLeaflet._initWindy()/onDrawLayer().
 */

var Windy = function (params) {

	const VELOCITY_SCALE = 0.022 * (Math.pow(window.devicePixelRatio,1/3) || 1); // RETTET: 0.005 → 0.022 (bruger-rapport: næsten usynlig)
	// RETTET (bruger-rapport: "alle strømme er røde" — midt-august havde ALLE
	// danske vandtemperaturer ligget i den øverste tredjedel af en fast 0-22°C-
	// skala, så farven næsten ikke varierede). Skalaen er nu RELATIV til det
	// datasæt, der reelt hentes — caller (dansk-overloeb-kort.html) beregner
	// selv min/max blandt de faktiske (ikke-maskerede) vandpunkter og sender
	// dem som params.minTemp/params.maxTemp (Kelvin). Disse to konstanter
	// forbliver kun som FALDBACK, hvis caller ikke angiver dem.
	const MIN_TEMPERATURE_K_DEFAULT = 273.15; // 0°C
	const MAX_TEMPERATURE_K_DEFAULT = 295.15; // 22°C
	const MAX_PARTICLE_AGE = 120;                                                // RETTET: 90 → 120 (længere, mere synlige spor)
	const PARTICLE_LINE_WIDTH = 4.5;                                             // RETTET: 3 → 4.5 (bruger-rapport: for spinkelt/lav kontrast, se PARTICLE_HALO_* nedenfor)
	// RETTET (bruger-rapport: for lav kontrast mod det nye, lyse grå Skærmkort-
	// basiskort, især zoomet ud) — en mørk, halvtransparent "halo" strøget
	// BREDERE end og UNDER selve den farvede streg (se draw() nedenfor)
	// garanterer synlighed uanset stregens egen farve/lyshed og uanset
	// baggrundskortets aktuelle gråtone, i stedet for at skulle stole på at
	// hver enkelt temperaturfarve i sig selv har nok kontrast.
	const PARTICLE_HALO_LINE_WIDTH = PARTICLE_LINE_WIDTH + 3.5;
	const PARTICLE_HALO_COLOR = 'rgba(10,20,35,0.55)';
	// RETTET (bruger-krav: hurtigere strøm skal have en LÆNGERE, mere
	// markant hale end langsommere strøm) — hvert billedes segment (x,y)→
	// (xt,yt) er i sig selv allerede proportional med farten (v[0]/v[1] ER
	// billedets pixel-forskydning), men denne strækker segmentets START-
	// punkt YDERLIGERE tilbage, proportionalt med samme hastighedsvektor
	// (se evolve()/draw() nedenfor: particle.xs/ys) — så forskellen mellem
	// hurtig og langsom strøm bliver visuelt tydelig ÉN halelængde ad
	// gangen, ikke kun via hvor mange (ens-falmende) tidligere billeder der
	// statistisk overlapper. 1 = intet ekstra (kun det naturlige segment).
	const TAIL_LENGTH_MULTIPLIER = 2.5;
	const PARTICLE_MULTIPLIER = 1 / 60;                                          // RETTET: 1/200 → 1/60 (tættere partikelfelt)
	const PARTICLE_REDUCTION = (Math.pow(window.devicePixelRatio,1/3) || 1.6);   // multiply particle count for mobiles by this amount
	const FRAME_RATE = 15, FRAME_TIME = 1000 / FRAME_RATE;                       // desired frames per second

	var NULL_WIND_VECTOR = [NaN, NaN, null];                                     // singleton for no wind in the form: [u, v, magnitude]

	var builder;
	var grid;
	var date;
	var λ0, φ0, Δλ, Δφ, ni, nj;

	// interpolation for vectors like wind (u,v,m)
	var bilinearInterpolateVector = function (x, y, g00, g10, g01, g11) {
		var rx = (1 - x);
		var ry = (1 - y);
		var a = rx * ry, b = x * ry, c = rx * y, d = x * y;
		var u = g00[0] * a + g10[0] * b + g01[0] * c + g11[0] * d;
		var v = g00[1] * a + g10[1] * b + g01[1] * c + g11[1] * d;
		var tmp = g00[2] * a + g10[2] * b + g01[2] * c + g11[2] * d;
		return [u, v, tmp];
	};

	var createWindBuilder = function (uComp, vComp, temp) {
		var uData = uComp.data, vData = vComp.data, tempData = temp.data;
		return {
			header: uComp.header,
			// RETTET (se filhoved): null i u-komponenten er vores sentinel for
			// "intet vand her" (land/uden for masken, eller manglende CMEMS-
			// punkt) — returnér null for HELE gitterpunktet, ikke en tegnelig
			// [0,0,temp]-vektor, så windy's egen isValue()-baserede
			// interpolate() springer cellen helt over. (null, ikke NaN, fordi
			// JSON.stringify(NaN) bliver til "null" alligevel over API'et —
			// null er sentinel'en HELE VEJEN, server såvel som klient.)
			data: function (i) {
				var u = uData[i];
				if (u === null) return null;
				return [u, vData[i], tempData[i]];
			},
			interpolate: bilinearInterpolateVector
		}
	};

	var createBuilder = function (data) {
		var uComp = null, vComp = null, temp = null, scalar = null;

		data.forEach(function (record) {
			switch (record.header.parameterCategory + "," + record.header.parameterNumber) {
				case "2,2": uComp = record; break;
				case "2,3": vComp = record; break;
				case "0,0": temp = record; break;
				default:
					scalar = record;
			}
		});

		return createWindBuilder(uComp, vComp, temp);
	};

	var buildGrid = function (data, callback) {

		builder = createBuilder(data);
		var header = builder.header;

		λ0 = header.lo1;
		φ0 = header.la1;  // the grid's origin (e.g., 0.0E, 90.0N)

		Δλ = header.dx;
		Δφ = header.dy;    // distance between grid points (e.g., 2.5 deg lon, 2.5 deg lat)

		ni = header.nx;
		nj = header.ny;    // number of grid points W-E and N-S (e.g., 144 x 73)

		date = new Date(header.refTime);
		date.setHours(date.getHours() + header.forecastTime);

		// Scan mode 0 assumed. Longitude increases from λ0, and latitude decreases from φ0.
		// http://www.nco.ncep.noaa.gov/pmb/docs/grib2/grib2_table3-4.shtml
		grid = [];
		var p = 0;
		var isContinuous = Math.floor(ni * Δλ) >= 360;

		for (var j = 0; j < nj; j++) {
			var row = [];
			for (var i = 0; i < ni; i++, p++) {
				row[i] = builder.data(p);
			}
			if (isContinuous) {
				// For wrapped grids, duplicate first column as last column to simplify interpolation logic
				row.push(row[0]);
			}
			grid[j] = row;
		}

		callback({
			date: date,
			interpolate: interpolate
		});
	};

	/**
	 * Get interpolated grid value from Lon/Lat position
	 * @param λ {Float} Longitude
	 * @param φ {Float} Latitude
	 * @returns {Object}
	 */
	var interpolate = function(λ, φ) {

		if(!grid) return null;

		var i = floorMod(λ - λ0, 360) / Δλ;  // calculate longitude index in wrapped range [0, 360)
		var j = (φ0 - φ) / Δφ;                 // calculate latitude index in direction +90 to -90

		var fi = Math.floor(i), ci = fi + 1;
		var fj = Math.floor(j), cj = fj + 1;

		var rowF = grid[fj];
		var rowC = grid[cj];
		if (!rowF || !rowC) return null;

		var g00 = rowF[fi];
		var g10 = rowF[ci];
		var g01 = rowC[fi];
		var g11 = rowC[ci];

		// RETTET (fjorde/smalle bælter manglede næsten al animation, se
		// dansk-overloeb-kort.html's currents-BRUGERKRAV punkt 4 og
		// fetch_currents.py's STRIDE-kommentar): krævede TIDLIGERE, at ALLE
		// FIRE hjørner var gyldige, ellers blev HELE cellen sprunget over —
		// målt til at ramme ~91-93% af cellerne, der overlapper Isefjord,
		// selv efter at have halveret gitterafstanden (~10 km → ~5 km),
		// fordi en smal fjords celler næsten altid har mindst ét hjørne ude
		// i land/uden-for-CMEMS-masken. Tolererer nu OP TIL ét manglende
		// hjørne: erstattes med gennemsnittet af de øvrige tre (en rimelig
		// lokal antagelse — bedre end slet ingen animation) — kræver
		// stadig MINDST tre ægte datapunkter, så der aldrig interpoleres
		// ud fra kun ét eller to (evt. diagonale) punkter alene.
		var corners = [g00, g10, g01, g11];
		var valid = corners.filter(isValue);
		if (valid.length < 3) return null;

		if (valid.length < 4) {
			var avg = [0, 1, 2].map(function (k) {
				return valid.reduce(function (sum, v) { return sum + v[k]; }, 0) / valid.length;
			});
			corners = corners.map(function (v) { return isValue(v) ? v : avg; });
		}
		return builder.interpolate(i - fi, j - fj, corners[0], corners[1], corners[2], corners[3]);
	};



	/**
	 * @returns {Boolean} true if the specified value is not null and not undefined.
	 */
	var isValue = function (x) {
		return x !== null && x !== undefined;
	};

	/**
	 * @returns {Number} returns remainder of floored division, i.e., floor(a / n). Useful for consistent modulo
	 *          of negative numbers. See http://en.wikipedia.org/wiki/Modulo_operation.
	 */
	var floorMod = function (a, n) {
		return a - n * Math.floor(a / n);
	};

	/**
	 * @returns {Number} the value x clamped to the range [low, high].
	 */
	var clamp = function (x, range) {
		return Math.max(range[0], Math.min(x, range[1]));
	};

	/**
	 * @returns {Boolean} true if agent is probably a mobile device. Don't really care if this is accurate.
	 */
	var isMobile = function () {
		return (/android|blackberry|iemobile|ipad|iphone|ipod|opera mini|webos/i).test(navigator.userAgent);
	}

	/**
	 * Calculate distortion of the wind vector caused by the shape of the projection at point (x, y). The wind
	 * vector is modified in place and returned by this function.
	 */
	var distort = function (projection, λ, φ, x, y, scale, wind, windy) {
		var u = wind[0] * scale;
		var v = wind[1] * scale;
		var d = distortion(projection, λ, φ, x, y, windy);

		// Scale distortion vectors by u and v, then add.
		wind[0] = d[0] * u + d[2] * v;
		wind[1] = d[1] * u + d[3] * v;
		return wind;
	};

	var distortion = function (projection, λ, φ, x, y, windy) {
		var τ = 2 * Math.PI;
		var H = Math.pow(10, -5.2);
		var hλ = λ < 0 ? H : -H;
		var hφ = φ < 0 ? H : -H;

		var pλ = project(φ, λ + hλ, windy);
		var pφ = project(φ + hφ, λ, windy);

		// Meridian scale factor (see Snyder, equation 4-3), where R = 1. This handles issue where length of 1º λ
		// changes depending on φ. Without this, there is a pinching effect at the poles.
		var k = Math.cos(φ / 360 * τ);
		return [
			(pλ[0] - x) / hλ / k,
			(pλ[1] - y) / hλ / k,
			(pφ[0] - x) / hφ,
			(pφ[1] - y) / hφ
		];
	};

	var createField = function (columns, bounds, callback) {

		/**
		 * @returns {Array} wind vector [u, v, magnitude] at the point (x, y), or [NaN, NaN, null] if wind
		 *          is undefined at that point.
		 */
		function field(x, y) {
			if(!columns) return [NaN, NaN, null];
			var column = columns[Math.round(x)];
			return column && column[Math.round(y)] || NULL_WIND_VECTOR;
		}

		// Frees the massive "columns" array for GC. Without this, the array is leaked (in Chrome) each time a new
		// field is interpolated because the field closure's context is leaked, for reasons that defy explanation.
		field.release = function () {
			//delete columns;
			columns = [];
		};

		field.randomize = function (o) {  // UNDONE: this method is terrible
			var x, y;
			var safetyNet = 0;
			do {
				x = Math.round(Math.floor(Math.random() * bounds.width) + bounds.x);
				y = Math.round(Math.floor(Math.random() * bounds.height) + bounds.y)
			} while (field(x, y)[2] === null && safetyNet++ < 30);
			o.x = x;
			o.y = y;
			return o;
		};

		//field.overlay = mask.imageData;
		//return field;
		callback(bounds, field);
	};

	var buildBounds = function (bounds, width, height) {
		var upperLeft = bounds[0];
		var lowerRight = bounds[1];
		var x = Math.round(upperLeft[0]); //Math.max(Math.floor(upperLeft[0], 0), 0);
		var y = Math.max(Math.floor(upperLeft[1], 0), 0);
		var xMax = Math.min(Math.ceil(lowerRight[0], width), width - 1);
		var yMax = Math.min(Math.ceil(lowerRight[1], height), height - 1);
		return { x: x, y: y, xMax: width, yMax: yMax, width: width, height: height };
	};

	var deg2rad = function (deg) {
		return (deg / 180) * Math.PI;
	};

	var rad2deg = function (ang) {
		return ang / (Math.PI / 180.0);
	};

	var invert = function (x, y, windy) {
		var mapLonDelta = windy.east - windy.west;
		var worldMapRadius = windy.width / rad2deg(mapLonDelta) * 360 / (2 * Math.PI);
		var mapOffsetY = (worldMapRadius / 2 * Math.log((1 + Math.sin(windy.south)) / (1 - Math.sin(windy.south))));
		var equatorY = windy.height + mapOffsetY;
		var a = (equatorY - y) / worldMapRadius;

		var lat = 180 / Math.PI * (2 * Math.atan(Math.exp(a)) - Math.PI / 2);
		var lon = rad2deg(windy.west) + x / windy.width * rad2deg(mapLonDelta);
		return [lon, lat];
	};

	var mercY = function (lat) {
		return Math.log(Math.tan(lat / 2 + Math.PI / 4));
	};


	var project = function (lat, lon, windy) { // both in radians, use deg2rad if neccessary
		var ymin = mercY(windy.south);
		var ymax = mercY(windy.north);
		var xFactor = windy.width / (windy.east - windy.west);
		var yFactor = windy.height / (ymax - ymin);

		var y = mercY(deg2rad(lat));
		var x = (deg2rad(lon) - windy.west) * xFactor;
		var y = (ymax - y) * yFactor; // y points south
		return [x, y];
	};


	var interpolateField = function (grid, bounds, extent, callback) {

		var projection = {};

		var mapArea = ((extent.south - extent.north) * (extent.west - extent.east));
		var velocityScale = VELOCITY_SCALE * Math.pow(mapArea, 0.3);

		var columns = [];
		var x = bounds.x;

		function interpolateColumn(x) {
			var column = [];
			for (var y = bounds.y; y <= bounds.yMax; y += 2) {
				var coord = invert(x, y, extent);
				if (coord) {
					var λ = coord[0], φ = coord[1];
					if (isFinite(λ)) {
						var wind = grid.interpolate(λ, φ);
						if (wind) {
							wind = distort(projection, λ, φ, x, y, velocityScale, wind, extent);
							column[y + 1] = column[y] = wind;

						}
					}
				}
			}
			columns[x + 1] = columns[x] = column;
		}

		for (; x < bounds.width; x+= 2) {
			interpolateColumn(x);
		}
		createField(columns, bounds, callback);
	};

	var particles, animationLoop;
	var animate = function (bounds, field, extent) {

		function windTemperatureColorScale(minTemp, maxTemp) {

			// Lyseblå (koldt) → mørkerød (varmt) — 15-trins skala, genkalibreret
			// til MIN/MAX_TEMPERATURE_K ovenfor (danske hav-/søtemperaturer i
			// stedet for global wind-chill-range).
			// RETTET (bruger-rapport: for lav kontrast mod det lyse grå Skærmkort-
			// basiskort) — upstreams midtertrin (indeks 2-6, den pastelagtige
			// teal→gul-grøn overgang) var nær-hvide (fx "rgb(238,247,217)"),
			// hvilket praktisk talt forsvandt oven på en lys grå baggrund — og
			// netop DET interval rammes ofte, fordi danske sommer-havtemperaturer
			// typisk clusterer midt i skalaen (se skalaens EGEN filhoved om
          // "alle strømme er røde"-hændelsen). Alle midtertrin mørkere/mere
			// mættede her, samme hue-progression, blot uden pastel-udvanding.
			// Suppleres af PARTICLE_HALO_*-kontrastkanten i draw() nedenfor.
			var result = [
				"rgb(33,102,172)",
				"rgb(50,150,180)",
				"rgb(45,175,160)",
				"rgb(60,180,110)",
				"rgb(130,190,70)",
				"rgb(205,200,55)",
				"rgb(235,195,50)",
				"rgb(248,180,60)",
				"rgb(255,150,60)",
				"rgb(250,120,50)",
				"rgb(245,90,40)",
				"rgb(235,55,30)",
				"rgb(220,35,28)",
				"rgb(200,20,30)",
				"rgb(160,0,35)"
			]
			result.indexFor = function (m) {  // map temperature to a style
				return Math.max(0, Math.min((result.length - 1),
					Math.round((m - minTemp) / (maxTemp - minTemp) * (result.length - 1))));

			};
			return result;
		}

		// RETTET (se filhoved): relativ skala fremfor fast — params.minTemp/
		// maxTemp kommer fra callerens EGET min/max blandt de faktiske
		// vandpunkter i det aktuelle datasæt. Værn mod et (næsten) fladt
		// datasæt (minTemp≈maxTemp) — uden dette ville indexFor() dividere
		// med ~0 og give NaN, som buckets[NaN] ville crashe på.
		var scaleMin = (typeof params.minTemp === 'number') ? params.minTemp : MIN_TEMPERATURE_K_DEFAULT;
		var scaleMax = (typeof params.maxTemp === 'number') ? params.maxTemp : MAX_TEMPERATURE_K_DEFAULT;
		if (scaleMax - scaleMin < 0.5) { scaleMin -= 0.25; scaleMax += 0.25; }
		var colorStyles = windTemperatureColorScale(scaleMin, scaleMax);
		var buckets = colorStyles.map(function () { return []; });
		var mapArea = ((extent.south - extent.north) * (extent.west - extent.east));
		var particleCount = Math.round(bounds.width * bounds.height * PARTICLE_MULTIPLIER * Math.pow(mapArea, 0.24));
		if (isMobile()) {
			particleCount /= PARTICLE_REDUCTION;
		}

		particles = particles || [];
		if (particles.length > particleCount) particles = particles.slice(0, particleCount);
		for (var i = particles.length; i < particleCount; i++) {
			particles.push(field.randomize({ age: ~~(Math.random() * MAX_PARTICLE_AGE) + 0 }));
		}

		function evolve() {
			buckets.forEach(function (bucket) { bucket.length = 0; });
			particles.forEach(function (particle) {
				if (particle.age > MAX_PARTICLE_AGE) {
					field.randomize(particle).age = ~~(Math.random() * MAX_PARTICLE_AGE / 2);
				}
				var x = particle.x;
				var y = particle.y;
				var v = field(x, y);  // vector at current position
				var m = v[2];
				if (m === null) {
					particle.age = MAX_PARTICLE_AGE;  // particle has escaped the grid, never to return...
				}
				else {
					var xt = x + v[0];
					var yt = y + v[1];
					if (field(xt, yt)[0] !== null) {
						// Path from (x,y) to (xt,yt) is visible, so add this particle to the appropriate draw bucket.
						particle.xt = xt;
						particle.yt = yt;
						// RETTET (se TAIL_LENGTH_MULTIPLIER's filhoved): halens
						// STARTPUNKT trækkes tilbage langs samme retning som
						// bevægelsen selv (v[0]/v[1]) — jo hurtigere strømmen,
						// jo længere hale, uden at ændre selve partiklens
						// reelle position (xt/yt, som stadig kun rykker ét
						// naturligt skridt pr. billede).
						particle.xs = x - (TAIL_LENGTH_MULTIPLIER - 1) * v[0];
						particle.ys = y - (TAIL_LENGTH_MULTIPLIER - 1) * v[1];
						buckets[colorStyles.indexFor(m)].push(particle);
					}
					else {
						// Particle isn't visible, but it still moves through the field.
						particle.x = xt;
						particle.y = yt;
					}
				}
				particle.age += 1;
			});
		}

		var g = params.canvas.getContext("2d");
		g.lineWidth = PARTICLE_LINE_WIDTH;
		g.lineCap = 'round'; // RETTET: chunkigere/mere synlige partikel-endepunkter end standard 'butt'

		function draw() {
			// Fade existing particle trails.
			g.save();
			g.globalAlpha = .16;
			g.globalCompositeOperation = 'destination-out';
			g.fillStyle = '#000';
			g.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
			g.restore();

			// Draw new particle trails. Stien bygges ÉN gang pr. bucket, men
			// strøges TO gange (halo, så farve) — se PARTICLE_HALO_*'s filhoved
			// for hvorfor. moveTo/lineTo-koordinaterne opdaterer IKKE
			// particle.x/y, så samme sti kan genbruges til begge strøg.
			buckets.forEach(function (bucket, i) {
				if (bucket.length > 0) {
					g.beginPath();
					bucket.forEach(function (particle) {
						g.moveTo(particle.xs, particle.ys);
						g.lineTo(particle.xt, particle.yt);
					});
					g.lineWidth = PARTICLE_HALO_LINE_WIDTH;
					g.strokeStyle = PARTICLE_HALO_COLOR;
					g.stroke();
					g.lineWidth = PARTICLE_LINE_WIDTH;
					g.strokeStyle = colorStyles[i];
					g.stroke();
					bucket.forEach(function (particle) {
						particle.x = particle.xt;
						particle.y = particle.yt;
					});
				}
			});
		}

		var then = Date.now();
		(function frame() {
			animationLoop = requestAnimationFrame(frame);
			var now = Date.now()
			var delta = now - then;
			if (delta > FRAME_TIME) {
				then = now - (delta % FRAME_TIME);
				evolve();
				draw();
			}
		})();
	};

	var updateData = function (data, bounds, width, height, extent) {
		delete params.data;
		params.data = data;
		if (extent)
			start(bounds, width, height, extent);
	};

	var start = function (bounds, width, height, extent) {
		var mapBounds = {
			south: deg2rad(extent[0][1]),
			north: deg2rad(extent[1][1]),
			east: deg2rad(extent[1][0]),
			west: deg2rad(extent[0][0]),
			width: width,
			height: height
		};
		stop();
		// build grid
		buildGrid(params.data, function (grid) {
			// interpolateField
			interpolateField(grid, buildBounds(bounds, width, height), mapBounds, function (bounds, field) {
				// animate the canvas with random points
				windy.field = field;
				animate(bounds, field, mapBounds);
			});

		});
	};

	var stop = function () {
		if (windy.field) windy.field.release();
		if (animationLoop) cancelAnimationFrame(animationLoop);
	};

	var shift = function (dx, dy) {
		var canvas = params.canvas, w = canvas.width, h = canvas.height, ctx = canvas.getContext("2d");
		if (w > dx && h > dy) {
			var clamp = function (high, value) { return Math.max(0, Math.min(high, value)); };
			var imageData = ctx.getImageData(clamp(w, -dx), clamp(h, -dy), clamp(w, w - dx), clamp(h, h - dy));
			ctx.clearRect(0, 0, w, h);
			ctx.putImageData(imageData, clamp(w, dx), clamp(h, dy));
			for (var i = 0, pLength = particles.length; i < pLength; i++) {
				particles[i].x += dx;
				particles[i].y += dy;
			}
		}
	};

	var windy = {
		params: params,
		start: start,
		stop: stop,
		update: updateData,
		shift: shift,
		createField: createField,
		interpolatePoint: interpolate
	};

	return windy;
};

// shim layer with setTimeout fallback
window.requestAnimationFrame = (function () {
	return window.requestAnimationFrame ||
		window.webkitRequestAnimationFrame ||
		window.mozRequestAnimationFrame ||
		window.oRequestAnimationFrame ||
		window.msRequestAnimationFrame ||
		function (callback) {
			return window.setTimeout(callback, 1000 / 15);
		};
})();

if(!window.cancelAnimationFrame) {
	window.cancelAnimationFrame = function (id) {
		clearTimeout(id);
	};
}
