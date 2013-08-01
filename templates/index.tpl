<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="">
    <meta name="author" content="">

    <title>Are they using Google Apps?</title>

    <!-- Bootstrap core CSS -->
    <link href="/static/css/bootstrap.css" rel="stylesheet">

    <!-- Custom styles for this template -->
    <link href="/static/css/signin.css" rel="stylesheet">
  </head>

  <body>
    <div class="container">
    <center><h2>Are they using Google Apps?</h2></center>
      <form class="form-signin" method="POST" action="/result">
        <h3 class="form-signin-heading">Enter the domain (or email address):</h3>

        <input type="text" class="form-control" name=domain placeholder="user@example.com" autofocus>

        <button class="btn btn-large btn-primary btn-block" type="submit">Check!</button>
      </form>
    <center><small>A very quick and ugly app by <a href="http://viktorpetersson.com">Viktor Petersson</a> to check if the other party is on Google Apps before scheduling a Google Hangout session.</small></center>
    </div> <!-- /container -->

  </body>
</html>
