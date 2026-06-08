FROM docker.io/cloudflare/sandbox:0.11.0-python

RUN ln -sf /usr/local/bin/python3 /usr/local/bin/python \
  && ln -sf /usr/local/bin/pip3 /usr/local/bin/pip \
  && pip3 install --no-cache-dir ruff==0.14.8 pytest==9.0.2
RUN npm install -g typescript@6.0.3
