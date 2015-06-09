<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="">
    <meta name="author" content="">

    <title>Are they using Google Apps?</title>

    <!-- start Mixpanel -->
    <script type="text/javascript">(function(f,b){if(!b.__SV){var a,e,i,g;window.mixpanel=b;b._i=[];b.init=function(a,e,d){function f(b,h){var a=h.split(".");2==a.length&&(b=b[a[0]],h=a[1]);b[h]=function(){b.push([h].concat(Array.prototype.slice.call(arguments,0)))}}var c=b;"undefined"!==typeof d?c=b[d]=[]:d="mixpanel";c.people=c.people||[];c.toString=function(b){var a="mixpanel";"mixpanel"!==d&&(a+="."+d);b||(a+=" (stub)");return a};c.people.toString=function(){return c.toString(1)+".people (stub)"};i="disable track track_pageview track_links track_forms register register_once alias unregister identify name_tag set_config people.set people.set_once people.increment people.append people.union people.track_charge people.clear_charges people.delete_user".split(" ");
    for(g=0;g<i.length;g++)f(c,i[g]);b._i.push([a,e,d])};b.__SV=1.2;a=f.createElement("script");a.type="text/javascript";a.async=!0;a.src="undefined"!==typeof MIXPANEL_CUSTOM_LIB_URL?MIXPANEL_CUSTOM_LIB_URL:"//cdn.mxpnl.com/libs/mixpanel-2-latest.min.js";e=f.getElementsByTagName("script")[0];e.parentNode.insertBefore(a,e)}})(document,window.mixpanel||[]);
    mixpanel.init("4c86fe4ff71ec68618de156215bda96f");
    mixpanel.track("Loaded Front-page");
    mixpanel.track_forms("#submit_form", "Submitted Query")
    </script>
    <!-- end Mixpanel -->

    <!-- Bootstrap core CSS -->
    <link href="/static/css/bootstrap.css" rel="stylesheet">

    <!-- Custom styles for this template -->
    <link href="/static/css/signin.css" rel="stylesheet">
  </head>

  <body>
    <div class="container">
    <center><h2>Are they using Google Apps?</h2></center>
      <form id="submit_form" class="form-signin" method="POST" action="/result">
        <h3 class="form-signin-heading">Enter the domain (or email address):</h3>

        <input type="text" class="form-control" name=domain placeholder="user@example.com" autofocus>

        <button class="btn btn-large btn-primary btn-block" type="submit">Check!</button>
      </form>
    <center><small><p>A very quick and ugly app by <a href="http://viktorpetersson.com">Viktor Petersson</a> to check if the other party is on Google Apps before scheduling a Google Hangout session.</p><p>The source code is available on <a href="https://github.com/vpetersson/aretheyusinggoogleapps.com">Github</a>.</p></small></center>
    </div>

  </body>
</html>
