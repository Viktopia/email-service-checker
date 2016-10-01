#!/usr/bin/env python
# -*- coding: utf-8 -*-

from sys import argv
from socket import gethostname

from urlparse import urlparse

from bottle import get, post, request, template, route, static_file
from bottle import debug as bottle_debug
from bottle import run as bottle_run

import dns.resolver
import settings


def is_running_google_apps(domain):
    result = False

    try:
        query = dns.resolver.query(domain, 'MX')
    except:
        return result

    for rdata in query:
        if ('google.com' or 'googlemail.com') in str(rdata).lower():
            result = True
            break

    return result


def guess_domain(input):
    guess_domain = input

    # If it's an email, just use the part after the @
    if '@' in input:
        guess_domain = input.split('@')[1]

    if len(guess_domain) == 0:
        return {'status': False, 'msg': 'Invalid domain name'}

    # Append http:// to satisfy urlparse if missing
    if not guess_domain.startswith('http://' or 'https://'):
        guess_domain = 'http://{}'.format(guess_domain)

    parse_domain = urlparse(guess_domain)

    # Extract the 'netloc' block from urlparse
    educated_guess = parse_domain[1]

    return {'status': True, 'domain': educated_guess}


@route('/static/:filename#.*#')
def send_static(filename):
    return static_file(filename, root='./static/')


@get('/')
def input_form():
    return template('templates/index')


@post('/result')
def build_links():
    input = request.forms.get('domain')

    if not input:
        return "Invalid input"

    domain = guess_domain(input)
    if not domain['status']:
        result = domain['msg']
    else:
        query = is_running_google_apps(domain['domain'])

        if query:
            result = "Yes they are. :)"
        else:
            result = "No, they aren't :("

    return template('templates/result', result=result)

bottle_run(host=settings.LISTEN, port=settings.PORT, reloader=True)
