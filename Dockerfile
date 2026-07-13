FROM apify/actor-node:22

COPY --chown=myuser:myuser package*.json ./

# Do NOT use --omit=optional here. impit's Rust native binary ships via napi-rs optionalDependencies.
RUN npm --quiet set progress=false \
    && npm install --omit=dev \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version

COPY --chown=myuser:myuser . ./

ENV APIFY_LOG_LEVEL=INFO

CMD npm start --silent
